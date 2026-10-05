import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { callId } from "./lib/layout.ts";
import { observedDates } from "./lib/source.ts";
import { parseYaml } from "./lib/yaml.ts";

type Any = any;
export type Level = "breaking" | "additive" | "other";
export type Section = "Breaking" | "Added" | "Changed" | "Deprecated" | "Removed" | "Newly observed";
export type Change = { id: string; path: string; section: Section; level: Level; note: string };
export type Snapshot = { kinds: Any; schemas: Record<string, Any>; templates: Record<string, Any>; calls: Any[]; groups: Any[] };

const SECTIONS: Section[] = ["Breaking", "Added", "Changed", "Deprecated", "Removed", "Newly observed"];
const RANK: Record<Level, number> = { other: 0, additive: 1, breaking: 2 };

// ---- snapshots

export function buildSnapshot(files: Record<string, string>): Snapshot {
  const snap: Snapshot = { kinds: {}, schemas: {}, templates: {}, calls: [], groups: [] };
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith(".yaml")) continue;
    const doc = parseYaml(text);
    if (path === "kinds.yaml") snap.kinds = doc;
    else if (path.startsWith("schemas/")) snap.schemas[path.slice(8, -5)] = doc;
    else if (path.startsWith("templates/")) snap.templates[path.slice(10, -5)] = doc;
    else if (path.startsWith("calls/")) (path.split("/").pop()!.startsWith("_") ? snap.groups : snap.calls).push(doc);
  }
  return snap;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Template-backed calls are expanded to one virtual call per template action so edits attribute to each caller. */
function indexCalls(s: Snapshot): Map<string, Any> {
  const m = new Map<string, Any>();
  for (const c of s.calls) {
    if (!c.uses) {
      m.set(callId(c), c);
      continue;
    }
    const t = s.templates[c.uses.template];
    for (const [name, a] of Object.entries<Any>(t?.actions ?? {})) {
      const prefix = c.uses.prefix ?? "";
      const v = { kind: c.kind, path: c.path, ...a, action: prefix ? prefix + name : lowerFirst(name), source: { request: "inferred", response: "inferred" } };
      m.set(callId(v), v);
    }
  }
  return m;
}

// ---- schema comparison

type Side = { schemas: Record<string, Any> };

function deref(n: Any, side: Side, stack: string[]): [Any, string[]] | null {
  if (n && typeof n === "object" && typeof n.$ref === "string") {
    if (stack.includes(n.$ref)) return null;
    return [side.schemas[n.$ref] ?? {}, [...stack, n.$ref]];
  }
  return [n ?? {}, stack];
}

const ANY = null;
function typeSet(s: Any): Set<string> | null {
  let t = s.type;
  if (!t) t = s.properties ? "object" : s.items ? "array" : undefined;
  if (!t) return s.enum ? null : ANY;
  const set = new Set<string>(Array.isArray(t) ? t : [t]);
  if (s.nullable) set.add("null");
  return set;
}
const subset = (x: Set<string> | null, y: Set<string> | null) => {
  if (y === null) return true;
  if (x === null) return false;
  return [...x].every((t) => y.has(t) || (t === "integer" && y.has("number")));
};
const showT = (t: Set<string> | null) => (t ? [...t].sort().join("|") : "any");

type Dir = "request" | "response";
type Sink = (level: Level, section: Section, note: string) => void;

function cmpSchema(a: Any, b: Any, sa: Side, sb: Side, dir: Dir, at: string, out: Sink, stA: string[] = [], stB: string[] = []): void {
  const da = deref(a, sa, stA);
  const db = deref(b, sb, stB);
  if (!da || !db) return;
  const [A, nA] = da;
  const [B, nB] = db;
  const ta = typeSet(A);
  const tb = typeSet(B);
  if (showT(ta) !== showT(tb)) {
    const ok = dir === "response" ? subset(tb, ta) : subset(ta, tb);
    if (!ok) out("breaking", "Breaking", `${at} type ${showT(ta)} -> ${showT(tb)}`);
    else out(dir === "request" ? "additive" : "other", dir === "request" ? "Added" : "Changed", `${at} type ${showT(ta)} -> ${showT(tb)}`);
  }
  if (A.enum || B.enum) {
    const ea: Any[] = A.enum ?? [];
    const eb: Any[] = B.enum ?? [];
    const added = eb.filter((v) => !ea.includes(v));
    const removed = ea.filter((v) => !eb.includes(v));
    if (A.enum && added.length) out("additive", "Added", `${at} enum +${added.join(", ")}`);
    if (!A.enum && B.enum) out(dir === "request" ? "breaking" : "other", dir === "request" ? "Breaking" : "Changed", `${at} now restricted to enum`);
    if (removed.length) out(dir === "request" ? "breaking" : "other", dir === "request" ? "Breaking" : "Changed", `${at} enum -${removed.join(", ")}`);
    if (A.enum && !B.enum) out("other", "Changed", `${at} enum dropped`);
  }
  if (A.properties || B.properties) {
    const pa = A.properties ?? {};
    const pb = B.properties ?? {};
    const reqA = new Set<string>(A.required ?? []);
    const reqB = new Set<string>(B.required ?? []);
    for (const k of Object.keys(pa)) if (!(k in pb)) out("breaking", "Breaking", `${dir} field removed: ${at}.${k}`);
    for (const k of Object.keys(pb)) {
      if (!(k in pa)) {
        if (dir === "request" && reqB.has(k)) out("breaking", "Breaking", `${at}.${k} newly required`);
        else out("additive", "Added", `${dir} field added: ${at}.${k}`);
      } else {
        cmpSchema(pa[k], pb[k], sa, sb, dir, `${at}.${k}`, out, nA, nB);
        if (dir === "request" && reqB.has(k) && !reqA.has(k)) out("breaking", "Breaking", `${at}.${k} newly required`);
      }
    }
  }
  if (A.items || B.items) {
    if (A.items && B.items) cmpSchema(A.items, B.items, sa, sb, dir, `${at}[]`, out, nA, nB);
  }
  for (const k of ["oneOf", "anyOf", "allOf"]) {
    if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) out("other", "Changed", `${at} ${k} changed`);
  }
  if (A.description !== B.description) out("other", "Changed", "schema docs");
}

// ---- call comparison

function paramGroups(c: Any): Record<string, Record<string, Any>> {
  return { query: c.query ?? {}, path: c.path_params ?? {}, body: c.body?.params ?? {} };
}

function cmpCall(a: Any, b: Any, sa: Side, sb: Side, out: Sink): void {
  if (!a.removed && b.removed) out("breaking", "Removed", "marked removed");
  if (!a.deprecated && b.deprecated) out("additive", "Deprecated", typeof b.deprecated === "string" ? b.deprecated : "deprecated");
  if (a.deprecated && !b.deprecated) out("other", "Changed", "no longer deprecated");

  const ga = paramGroups(a);
  const gb = paramGroups(b);
  for (const loc of Object.keys(ga)) {
    const pa = ga[loc];
    const pb = gb[loc];
    const gone = Object.keys(pa).filter((k) => !(k in pb));
    const fresh = Object.keys(pb).filter((k) => !(k in pa));
    const shape = (p: Any) => JSON.stringify([p.type, p.enum, p.$ref]);
    for (const g of [...gone]) {
      const m = fresh.find((f) => shape(pa[g]) === shape(pb[f]));
      if (m === undefined) continue;
      out("breaking", "Breaking", `${loc} param renamed: ${g} -> ${m}`);
      gone.splice(gone.indexOf(g), 1);
      fresh.splice(fresh.indexOf(m), 1);
    }
    for (const k of gone) out("breaking", "Breaking", `${loc} param removed: ${k}`);
    for (const k of fresh) {
      if (pb[k].required === true) out("breaking", "Breaking", `${loc} param newly required: ${k}`);
      else out("additive", "Added", `${loc} param added: ${k}`);
    }
    for (const k of Object.keys(pb)) {
      if (!(k in pa)) continue;
      if (pb[k].required === true && pa[k].required !== true) out("breaking", "Breaking", `${loc} param newly required: ${k}`);
      const strip = ({ required: _r, description: _d, ...rest }: Any) => rest;
      cmpSchema(strip(pa[k]), strip(pb[k]), sa, sb, "request", `${loc} param ${k}`, out);
      if (pa[k].description !== pb[k].description) out("other", "Changed", "param docs");
    }
  }
  if (a.body?.schema || b.body?.schema) cmpSchema(a.body?.schema ?? {}, b.body?.schema ?? {}, sa, sb, "request", "body", out);
  if (a.body?.content_type !== b.body?.content_type) out("breaking", "Breaking", `body content type ${a.body?.content_type ?? "form"} -> ${b.body?.content_type ?? "form"}`);

  const ra = a.response ?? {};
  const rb = b.response ?? {};
  if (!!ra.envelope !== !!rb.envelope) out("breaking", "Breaking", "response envelope changed");
  if (!!ra.document !== !!rb.document || ra.content_type !== rb.content_type) out("breaking", "Breaking", "response content type changed");
  if (ra.schema || rb.schema) cmpSchema(ra.schema ?? {}, rb.schema ?? {}, sa, sb, "response", "response", out);

  const text: string[] = [];
  const diff = (label: string, x: Any, y: Any) => JSON.stringify(x) !== JSON.stringify(y) && text.push(label);
  diff("summary", a.summary, b.summary);
  diff("description", a.description, b.description);
  diff("notes", a.notes, b.notes);
  diff("tags", a.tags, b.tags);
  diff("response description", ra.description, rb.description);
  diff("examples", [ra.examples, a.body?.example], [rb.examples, b.body?.example]);
  if (text.length) out("other", "Changed", `${text.join(", ")} changed`);

  cmpSource(a.source, b.source, out);
}

function cmpSource(a: Any, b: Any, out: Sink): void {
  if (!a || !b) return;
  const up: string[] = [];
  const down: string[] = [];
  for (const p of ["request", "response"] as const) {
    if (b[p] === "observed" && a[p] !== "observed") up.push(p);
    if (a[p] === "observed" && b[p] !== "observed") down.push(p);
  }
  if (up.length) {
    const d = observedDates(b);
    out("other", "Newly observed", `${up.join(" and ")}${[...new Set(Object.values(d))].length === 1 ? ` on ${Object.values(d)[0]}` : ""}`);
  }
  if (down.length) out("other", "Changed", `${down.join(" and ")} no longer observed`);
  if (!up.length && !down.length && JSON.stringify(a.observed_on) !== JSON.stringify(b.observed_on)) out("other", "Changed", "observed_on updated");
}

const pathOf = (id: string) => id.replace(/^\S+ /, "").split(" ")[0];

export function diffSnapshots(base: Snapshot, head: Snapshot): Change[] {
  const changes: Change[] = [];
  const ia = indexCalls(base);
  const ib = indexCalls(head);
  const push = (id: string, level: Level, section: Section, note: string) => changes.push({ id, path: pathOf(id), section, level, note });
  for (const [id] of ia) if (!ib.has(id)) push(id, "breaking", "Removed", "call removed");
  for (const [id, b] of ib) {
    const a = ia.get(id);
    if (!a) push(id, "additive", "Added", b.summary ?? "");
    else cmpCall(a, b, base, head, (l, s, n) => push(id, l, s, n));
  }
  const gk = (g: Any) => `${g.method} ${g.path} (shared text)`;
  const ga = new Map<string, Any>(base.groups.map((g) => [gk(g), g]));
  const gb = new Map<string, Any>(head.groups.map((g) => [gk(g), g]));
  for (const k of new Set([...ga.keys(), ...gb.keys()])) {
    if (JSON.stringify(ga.get(k)) !== JSON.stringify(gb.get(k))) push(k, "other", "Changed", "shared text changed");
  }
  if (JSON.stringify(base.kinds) !== JSON.stringify(head.kinds)) push("kinds.yaml", "other", "Changed", "call kind definitions changed");
  return changes;
}

// ---- bump

export const levelOf = (changes: Change[]): Level | null =>
  changes.reduce<Level | null>((m, c) => (m === null || RANK[c.level] > RANK[m] ? c.level : m), null);

export function bumpVersion(version: string, level: Level): string {
  const [maj, min, pat] = version.split(".").map(Number);
  if (maj === 0) return level === "breaking" ? `0.${min + 1}.0` : `0.${min}.${pat + 1}`;
  if (level === "breaking") return `${maj + 1}.0.0`;
  return level === "additive" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

// ---- rendering

const MAX_LINES = 150;
const clip = (s: string, n = 90) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const area = (path: string) => "/" + path.split("/").filter(Boolean).slice(0, 2).join("/");

type Item = { id: string; path: string; notes: string[] };

function items(changes: Change[], section: Section): Item[] {
  const m = new Map<string, Item>();
  for (const c of changes.filter((c) => c.section === section)) {
    const it = m.get(c.id) ?? { id: c.id, path: c.path, notes: [] };
    if (c.note && !it.notes.includes(c.note)) it.notes.push(c.note);
    m.set(c.id, it);
  }
  return [...m.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function line(it: Item): string {
  const shown = it.notes.slice(0, 3);
  const more = it.notes.length > 3 ? `; +${it.notes.length - 3} more` : "";
  return `- \`${it.id}\`${shown.length ? ` — ${clip(shown.join("; "))}${more}` : ""}`;
}

function renderSections(changes: Change[], mode: "full" | "summary"): string[] {
  const out: string[] = [];
  for (const s of SECTIONS) {
    const list = items(changes, s);
    if (!list.length) continue;
    out.push(`### ${s}`, "");
    const groups = new Map<string, Item[]>();
    for (const it of list) groups.set(area(it.path), [...(groups.get(area(it.path)) ?? []), it]);
    if (mode === "summary") {
      for (const [a, g] of groups) out.push(`- \`${a}\`: ${g.length} call${g.length === 1 ? "" : "s"}`);
    } else if (list.length <= 25) {
      out.push(...list.map(line));
    } else {
      for (const [a, g] of groups) {
        out.push(`**\`${a}\`** (${g.length})`, "");
        out.push(...g.slice(0, 3).map(line));
        if (g.length > 3) out.push(`- … and ${g.length - 3} more`);
        out.push("");
      }
      if (out[out.length - 1] === "") out.pop();
    }
    out.push("");
  }
  return out;
}

export function renderEntry(version: string, date: string, changes: Change[]): string {
  const head = [`## ${version} - ${date}`, ""];
  let body = renderSections(changes, "full");
  if (head.length + body.length > MAX_LINES) body = renderSections(changes, "summary");
  return [...head, ...body].join("\n").trimEnd() + "\n";
}

// ---- IO

const ROOT = resolve(import.meta.dir, "..");
const WATCHED = ["calls", "schemas", "templates", "kinds.yaml", "spec-header.yaml"];

function workingFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const w of WATCHED) {
    if (w.includes(".")) {
      if (existsSync(join(ROOT, w))) files[w] = readFileSync(join(ROOT, w), "utf8");
    } else for (const f of new Bun.Glob("**/*.yaml").scanSync({ cwd: join(ROOT, w) })) files[`${w}/${f}`] = readFileSync(join(ROOT, w, f), "utf8");
  }
  return files;
}

function git(args: string[], input?: string): Buffer {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdin: input === undefined ? undefined : Buffer.from(input), stderr: "pipe", maxBuffer: 1 << 30 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout as Buffer;
}

export function baseFiles(ref: string): Record<string, string> {
  const names = git(["ls-tree", "-r", "-z", "--name-only", ref, "--", ...WATCHED]).toString().split("\0").filter(Boolean);
  const files: Record<string, string> = {};
  if (!names.length) return files;
  const buf = git(["cat-file", "--batch"], names.map((n) => `${ref}:${n}\n`).join(""));
  let pos = 0;
  for (const n of names) {
    const nl = buf.indexOf(10, pos);
    const size = Number(buf.subarray(pos, nl).toString().split(" ")[2]);
    files[n] = buf.subarray(nl + 1, nl + 1 + size).toString("utf8");
    pos = nl + 2 + size;
  }
  return files;
}

const versionOf = (files: Record<string, string>): string | undefined => files["spec-header.yaml"] && parseYaml(files["spec-header.yaml"]).info?.version;

function setVersions(version: string) {
  const sh = join(ROOT, "spec-header.yaml");
  writeFileSync(sh, readFileSync(sh, "utf8").replace(/^(\s*version:\s*)"[^"]*"/m, `$1"${version}"`));
  for (const rel of ["package.json", "clients/typescript/package.json"]) {
    const pj = join(ROOT, rel);
    const text = readFileSync(pj, "utf8");
    writeFileSync(pj, /"version"\s*:/.test(text) ? text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`) : text.replace(/("name"\s*:\s*"[^"]*",)/, `$1\n  "version": "${version}",`));
  }
}

const HEADER = "# Changelog\n\nVersioning follows semver (pre-1.0: breaking changes bump minor, additive and other changes bump patch). Entries are generated by `bun run changelog`.\n\n";

function prependEntry(file: string, entry: string, version: string) {
  const p = join(ROOT, file);
  let text = existsSync(p) ? readFileSync(p, "utf8") : HEADER;
  const at = text.search(/^## /m);
  const rest = at < 0 ? "" : text.slice(at);
  const prefix = at < 0 ? text.trimEnd() + "\n\n" : text.slice(0, at);
  // A rerun against the same baseline replaces its own entry instead of stacking.
  const old = rest.startsWith(`## ${version} `) ? rest.replace(/^## [\s\S]*?(?=^## |(?![\s\S]))/m, "") : rest;
  writeFileSync(p, prefix + entry + (old ? "\n" + old : ""));
}

function main() {
  const argv = process.argv.slice(2);
  const has = (f: string) => argv.includes(f);
  const bi = argv.indexOf("--base");
  const ref = bi >= 0 ? argv[bi + 1] : "HEAD";
  const json = has("--json");
  const say = (s: string) => (json ? console.error(s) : console.log(s));

  let base: Record<string, string>;
  try {
    base = baseFiles(ref);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  if (!Object.keys(base).some((f) => f.startsWith("calls/"))) {
    say(`Baseline ${ref} has no calls/ directory, so a structural diff is meaningless. Write the changelog entry by hand.`);
    if (json) console.log(JSON.stringify({ base: ref, bump: null, skipped: "baseline has no calls/" }));
    return;
  }
  const head = workingFiles();
  const changes = diffSnapshots(buildSnapshot(base), buildSnapshot(head));
  const level = levelOf(changes);
  const previous = versionOf(base) ?? versionOf(head)!;
  const version = level ? bumpVersion(previous, level) : previous;

  const counts = Object.fromEntries(SECTIONS.map((s) => [s, new Set(changes.filter((c) => c.section === s).map((c) => c.id)).size]));
  if (json) {
    console.log(JSON.stringify({ base: ref, bump: level, previous, version, counts, changes: changes.length }, null, 2));
  }
  if (!level) return say("No documentation changes; no version bump.");
  const date = new Date().toISOString().slice(0, 10);
  const entry = renderEntry(version, date, changes);
  if (!json) console.log(`${level} change: ${previous} -> ${version}\n\n${entry}`);
  if (has("--dry-run")) return;
  setVersions(version);
  prependEntry("CHANGELOG.md", entry, version);
  say(`Wrote CHANGELOG.md and set version ${version}. Rerun gen:openapi and gen:ts.`);
}

if (import.meta.main) main();
