// Marks calls as observed from HAR captures and shape logs (.jsonl), and reports how observed traffic differs from the docs.
// Privacy: only request URLs, parameter names and response structure (key paths and JSON types) are read out; values are never printed or stored.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { callId, segments } from "./lib/layout.ts";
import { isShape, looksData, sampleValues, shapeOf, type Shape } from "./lib/shape.ts";
import { makeSource, observedDates, setSource, type Part, type Source } from "./lib/source.ts";
import { parseYaml } from "./lib/yaml.ts";

type Any = any;

const ROOT = resolve(import.meta.dir, "..");
const HOST = "www.onlinescoutmanager.co.uk";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const jsonOut = args.includes("--json");
const SEP = "\x1f";

const read = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), "utf8"));
const glob = (dir: string) => [...new Bun.Glob("**/*.yaml").scanSync({ cwd: join(ROOT, dir) })].sort();

const kinds = read("kinds.yaml");
const schemas: Record<string, Any> = {};
for (const f of glob("schemas")) schemas[f.replace(/\.yaml$/, "")] = read(`schemas/${f}`);
const templates: Record<string, Any> = {};
for (const f of glob("templates")) templates[f.replace(/\.yaml$/, "")] = read(`templates/${f}`);

// ---------------------------------------------------------------- privacy helpers

const safeSegment = (s: string) => (looksData(s) ? "*" : s);

function safeParamName(name: string): string {
  const m = name.match(/^([^[]*)((?:\[[^\]]*\])*)$/);
  if (!m) return "{id}";
  const base = looksData(m[1]) ? "{id}" : m[1];
  return base + [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => `[${x[1] === "" ? "" : safeSegment(x[1])}]`).join("");
}

const safePathSegment = (s: string) => (looksData(s) ? "{id}" : s);

// ---------------------------------------------------------------- call index

interface Target {
  id: string;
  file?: string;
  doc?: Any;
  method: string;
  path: string;
  action?: string;
  schema?: Any;
  wrap: boolean;
  document: boolean;
  removed: boolean;
  names?: string[];
  required: Set<string>;
  openBody: boolean;
}

const envelopeDefault = (kind: string) => (kind === "v3-route" ? kinds.kinds["v3-route"].envelope !== false : false);
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function docNames(doc: Any): { names: string[]; required: Set<string>; open: boolean } {
  const names: string[] = [];
  const required = new Set<string>();
  let open = false;
  for (const [n, p] of Object.entries<Any>(doc.query ?? {})) {
    if (n === "action") continue;
    names.push(n);
    if (p?.required) required.add(n);
  }
  for (const [n, p] of Object.entries<Any>(doc.body?.params ?? {})) {
    if (n === "action") continue;
    names.push(n);
    if (p?.required) required.add(n);
  }
  if (doc.body?.schema) {
    const props = Object.keys(doc.body.schema.properties ?? {});
    names.push(...props);
    if (!props.length || doc.body.schema.additionalProperties) open = true;
  }
  return { names, required, open };
}

const targets: Target[] = [];
for (const f of glob("calls")) {
  const doc = read(`calls/${f}`);
  if (f.split("/").pop()!.startsWith("_") || !doc?.path) continue;
  if (doc.uses) {
    const t = templates[doc.uses.template];
    for (const [name, a] of Object.entries<Any>(t.actions)) {
      const prefix: string = doc.uses.prefix ?? "";
      const r = a.response ?? {};
      targets.push({
        id: `${a.method} ${doc.path}?action=${prefix ? prefix + name : lcFirst(name)}`,
        method: a.method,
        path: doc.path,
        action: prefix ? prefix + name : lcFirst(name),
        schema: r.schema,
        wrap: r.envelope ?? false,
        document: !!r.document,
        removed: false,
        required: new Set(),
        openBody: true,
      });
    }
    continue;
  }
  const r = doc.response ?? {};
  const { names, required, open } = docNames(doc);
  targets.push({
    id: callId(doc).replace(/^(\w+ \S+) (\S+)$/, "$1?action=$2"),
    file: `calls/${f}`,
    doc,
    method: doc.method,
    path: doc.path,
    action: doc.action,
    schema: r.schema,
    wrap: r.envelope ?? envelopeDefault(doc.kind),
    document: !!r.document,
    removed: !!doc.removed,
    names,
    required,
    openBody: open,
  });
}

const extIndex = new Map<string, Target>();
const v3Targets: { t: Target; re: RegExp; literals: number }[] = [];
for (const t of targets) {
  if (t.path.startsWith("/ext/")) extIndex.set(`${t.method} ${t.path} ${t.action ?? ""}`, t);
  else {
    const segs = segments(t.path);
    v3Targets.push({ t, re: new RegExp("^/" + segs.map((s) => (/^\{[^}]+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "$"), literals: segs.filter((s) => !/^\{/.test(s)).length });
  }
}
v3Targets.sort((a, b) => b.literals - a.literals);

// ---------------------------------------------------------------- schema -> documented paths

interface DocShape {
  types: Map<string, Set<string>>;
  kids: Map<string, Set<string>>;
  any: Set<string>;
}

function docShape(schema: Any | undefined): DocShape {
  const shape: DocShape = { types: new Map(), kids: new Map(), any: new Set() };
  const add = (path: string, ts: string[]) => {
    const s = shape.types.get(path) ?? new Set();
    for (const t of ts) s.add(t);
    shape.types.set(path, s);
  };
  const kid = (path: string, k: string) => {
    const s = shape.kids.get(path) ?? new Set();
    s.add(k);
    shape.kids.set(path, s);
  };
  const walk = (node: Any, path: string, stack: string[]) => {
    if (node === true || node === undefined || node === null || typeof node !== "object") return void shape.any.add(path);
    if (typeof node.$ref === "string") {
      const name = node.$ref;
      if (stack.includes(name) || stack.length > 14 || !schemas[name]) return void shape.any.add(path);
      return walk(schemas[name], path, [...stack, name]);
    }
    const branches = [...(node.allOf ?? []), ...(node.anyOf ?? []), ...(node.oneOf ?? [])];
    for (const b of branches) walk(b, path, stack);
    const ts = ([] as string[]).concat(node.type ?? []);
    if (node.nullable) ts.push("null");
    if (node.properties) ts.push("object");
    if (node.items) ts.push("array");
    if (ts.length) add(path, ts);
    const hasKids = !!node.properties || (node.additionalProperties && typeof node.additionalProperties === "object") || !!node.items;
    if (!ts.length && !branches.length) shape.any.add(path);
    if (ts.includes("object") && !hasKids && !branches.length) shape.any.add(path);
    for (const [k, v] of Object.entries<Any>(node.properties ?? {})) {
      kid(path, k);
      walk(v, path + SEP + k, stack);
    }
    if (node.additionalProperties && typeof node.additionalProperties === "object") {
      kid(path, "{key}");
      walk(node.additionalProperties, path + SEP + "{key}", stack);
    }
    if (node.items) {
      kid(path, "[]");
      walk(node.items, path + SEP + "[]", stack);
    }
  };
  walk(schema ?? {}, "$", []);
  return shape;
}

// ---------------------------------------------------------------- captured structure

function flatten(shape: Shape, path: string, out: Map<string, Set<string>>) {
  const s = out.get(path) ?? new Set();
  for (const t of shape.t) s.add(t);
  out.set(path, s);
  if (shape.i) flatten(shape.i, path + SEP + "[]", out);
  for (const [k, v] of Object.entries(shape.k ?? {})) flatten(v, path + SEP + k, out);
}

/** Re-keys captured paths against the docs, so data-like keys never survive under an open-ended documented object. */
function normalise(raw: Map<string, Set<string>>, shape: DocShape): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [p, types] of raw) {
    const toks = p.split(SEP);
    let cur = "$";
    let dropped = false;
    for (let i = 1; i < toks.length; i++) {
      if (shape.any.has(cur)) {
        dropped = true;
        break;
      }
      let t = toks[i];
      const kids = shape.kids.get(cur);
      if (t !== "[]" && t !== "{key}" && !kids?.has(t) && kids?.has("{key}")) t = "{key}";
      cur += SEP + t;
    }
    if (dropped) continue;
    const s = out.get(cur) ?? new Set();
    for (const t of types) s.add(t);
    out.set(cur, s);
  }
  return out;
}

const show = (p: string) => p.split(SEP).slice(1).join(".").replace(/\.\[\]/g, "[]") || "$";

interface Diff {
  undocumented: Map<string, string>;
  neverSeen: string[];
  mismatch: string[];
}

function compare(seen: Map<string, Set<string>>, shape: DocShape): Diff {
  const diff: Diff = { undocumented: new Map(), neverSeen: [], mismatch: [] };
  for (const [p, types] of seen) {
    if (!shape.types.has(p) && !shape.any.has(p)) {
      const parent = p.split(SEP).slice(0, -1).join(SEP);
      if (shape.types.has(parent) || shape.any.has(parent) || parent === "$") if (!parentUndocumented(parent, shape)) diff.undocumented.set(show(p), [...types].sort().join("|"));
      continue;
    }
    const doc = shape.types.get(p);
    if (!doc || !doc.size) continue;
    const bad = [...types].filter((t) => !(doc.has(t) || (t === "integer" && doc.has("number")) || (t === "array" && doc.has("object"))));
    if (bad.length) diff.mismatch.push(`${show(p)}: seen ${bad.sort().join("|")}, documented ${[...doc].sort().join("|")}`);
  }
  for (const p of shape.types.keys()) {
    if (p === "$" || seen.has(p)) continue;
    const toks = p.split(SEP);
    const last = toks[toks.length - 1];
    if (last === "[]" || last === "{key}") continue;
    const parent = toks.slice(0, -1).join(SEP);
    if (seen.get(parent)?.has("object")) diff.neverSeen.push(show(p));
  }
  return diff;
}

const parentUndocumented = (p: string, shape: DocShape) => p !== "$" && !shape.types.has(p) && !shape.any.has(p);

// ---------------------------------------------------------------- strict validators

// Strict zod validators for every call, so an observed call is judged exactly as the generated client would.
const strictOut = join(ROOT, ".cache/osm-api-strict.ts");
const gen = Bun.spawnSync(["bun", join(ROOT, "scripts/gen-typescript.ts"), "--strict-all", "--out", strictOut], { cwd: ROOT });
if (gen.exitCode !== 0) {
  console.error(`strict validator generation failed:\n${gen.stderr.toString()}`);
  process.exit(2);
}
const strictApi: Any = await import(strictOut);
const strictCalls = new Map<string, Any>(strictApi.allCalls().map((c: Any) => [c.id, c]));

// Synthetic bodies built from a shape carry no real enum or format values, so only type errors count.
function strictIssues(id: string, body: Any, typesOnly = false): string[] {
  const c = strictCalls.get(id);
  if (!c?.response?.data) return [];
  const r = c.response.data.safeParse(body);
  if (r.success) return [];
  const out: string[] = [];
  const walk = (issues: Any[], prefix: string[]) => {
    for (const i of issues) {
      const path = [...prefix, ...i.path].map((k: string | number) => (typeof k === "number" ? "[]" : safeSegment(String(k))));
      const where = path.join(".").replace(/\.\[\]/g, "[]") || "$";
      if (i.code === "invalid_union" && Array.isArray(i.errors)) {
        out.push(`${where}: no union branch accepts it`);
        i.errors.forEach((e: Any[], n: number) => out.push(...issuesOf(e, path).map((m) => `  branch ${n}: ${m}`)));
      } else if (i.code === "invalid_type") out.push(`${where}: expected ${i.expected}, got ${/received (\w+)/.exec(i.message)?.[1] ?? "?"}`);
      else out.push(`${where}: ${i.code}`);
    }
  };
  const issuesOf = (issues: Any[], prefix: string[]) => {
    const keep = out.splice(0);
    walk(issues, prefix);
    return out.splice(0, out.length, ...keep);
  };
  walk(r.error.issues, []);
  return [...new Set(typesOnly ? out.filter((l) => /expected/.test(l)) : out)];
}

// ---------------------------------------------------------------- observations

/** One request from either input; `reply` is set only when it had a JSON reply. */
interface Obs {
  method: string;
  path: string;
  action?: string;
  names: Set<string>;
  date?: string;
  reply?: { shape: Shape; ok: boolean; samples: unknown[]; typesOnly: boolean };
}
interface Agg {
  target: Target;
  requests: number;
  dates: { request?: string; response?: string };
  extra: Set<string>;
  seenNames: Set<string>;
  allSubset: boolean;
  qualifies: boolean;
  responses: number;
  raw: Map<string, Set<string>>;
  enveloped: number;
  bare: number;
  strict: Set<string>;
}

const aggs = new Map<string, Agg>();
const unmatched = new Map<string, { method: string; path: string; action: string; names: Set<string>; count: number }>();
let apiRequests = 0;
let harFiles = 0;
let shapeLogs = 0;

const later = (a: string | undefined, b: string) => (!a || a === "unknown" || b > a ? b : a);

function bodyNames(post: Any): { names: string[]; action?: string } {
  const names: string[] = [];
  let action: string | undefined;
  if (!post) return { names };
  if (Array.isArray(post.params) && post.params.length) {
    for (const p of post.params) {
      names.push(p.name);
      if (p.name === "action") action = String(p.value);
    }
  } else if (typeof post.text === "string" && post.text) {
    const type = String(post.mimeType ?? "");
    if (type.includes("json")) {
      try {
        const j = JSON.parse(post.text);
        if (j && typeof j === "object" && !Array.isArray(j)) names.push(...Object.keys(j));
      } catch {}
    } else if (!type.includes("multipart")) {
      for (const pair of post.text.split("&")) {
        if (!pair) continue;
        const [k, v] = pair.split("=");
        const name = decodeURIComponent(k.replace(/\+/g, " "));
        names.push(name);
        if (name === "action") action = decodeURIComponent((v ?? "").replace(/\+/g, " "));
      }
    }
  }
  return { names, action };
}

function docMatcher(t: Target): (name: string) => boolean {
  if (t.openBody && !t.names) return () => true;
  const res = (t.names ?? []).map((n) => {
    const re = n
      .split(/(\[[^\]]*\])/)
      .map((part) => {
        const m = part.match(/^\[([^\]]*)\]$/);
        if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return /^(|n|m|\d+|\{.*\}|<.*>)$/.test(m[1]) ? "\\[[^\\]]*\\]" : `\\[${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`;
      })
      .join("");
    return new RegExp(`^${re}$`);
  });
  return (name) => res.some((r) => r.test(name));
}

function fromHar(entry: Any): Obs | undefined {
  const req = entry.request;
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.host !== HOST || !/^\/(ext|v3)\//.test(url.pathname)) return;
  const names = new Set<string>();
  let action = url.searchParams.get("action") ?? undefined;
  for (const k of new Set(url.searchParams.keys())) if (k !== "action") names.add(k);
  const b = bodyNames(req.postData);
  for (const n of b.names) if (n !== "action") names.add(n);
  action ??= b.action;
  const obs: Obs = { method: String(req.method).toUpperCase(), path: url.pathname, action, names, date: validDate(String(entry.startedDateTime ?? "").slice(0, 10)) };

  const res = entry.response;
  const mime = String(res?.content?.mimeType ?? "");
  if ((res?.status ?? 0) >= 200 && res.status < 300 && /json/i.test(mime) && typeof res.content?.text === "string" && res.content.text) {
    try {
      const text = res.content.encoding === "base64" ? Buffer.from(res.content.text, "base64").toString("utf8") : res.content.text;
      const json = JSON.parse(text);
      obs.reply = { shape: shapeOf(json), ok: !(json && typeof json === "object" && !Array.isArray(json) && json.status === false), samples: [json], typesOnly: false };
    } catch {}
  }
  return obs;
}

function fromShapeLog(line: Any): Obs | undefined {
  if (!line || typeof line !== "object" || typeof line.method !== "string" || typeof line.path !== "string" || !/^\/(ext|v3)\//.test(line.path)) return;
  const strings = (x: unknown) => (Array.isArray(x) ? x.filter((n): n is string => typeof n === "string") : []);
  const obs: Obs = {
    method: line.method.toUpperCase(),
    path: line.path,
    action: typeof line.action === "string" ? line.action : undefined,
    names: new Set([...strings(line.query_keys), ...strings(line.body_keys)].filter((n) => n !== "action")),
    date: validDate(String(line.date ?? "")),
  };
  if (typeof line.status === "number" && line.status >= 200 && line.status < 300 && isShape(line.shape)) {
    obs.reply = { shape: line.shape, ok: line.ok !== false, samples: sampleValues(line.shape), typesOnly: true };
  }
  return obs;
}

const validDate = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);

function observe(o: Obs) {
  apiRequests++;
  const { method, names, action } = o;
  let path = o.path;
  let target: Target | undefined;
  if (path.startsWith("/ext/")) {
    if (!path.endsWith("/")) path += "/";
    target = extIndex.get(`${method} ${path} ${action ?? ""}`);
  } else {
    path = path.replace(/\/+$/, "");
    target = v3Targets.find((x) => x.t.method === method && x.re.test(path))?.t;
  }
  if (!target) {
    const safePath = path.split("/").map(safePathSegment).join("/");
    const key = `${method} ${safePath} ${action ?? ""}`;
    const u = unmatched.get(key) ?? { method, path: safePath, action: action ? safeSegment(action) : "", names: new Set(), count: 0 };
    for (const n of names) u.names.add(safeParamName(n));
    u.count++;
    unmatched.set(key, u);
    return;
  }

  const date = o.date;
  let a = aggs.get(target.id);
  if (!a) {
    a = { target, requests: 0, dates: {}, extra: new Set(), seenNames: new Set(), allSubset: true, qualifies: false, responses: 0, raw: new Map(), enveloped: 0, bare: 0, strict: new Set() };
    aggs.set(target.id, a);
  }
  a.requests++;
  const match = docMatcher(target);
  const extras = [...names].filter((n) => !match(n));
  for (const n of names) a.seenNames.add(n);
  for (const n of extras) a.extra.add(safeParamName(n));
  if (!extras.length) {
    a.qualifies = true;
    if (date) a.dates.request = later(a.dates.request, date);
  } else a.allSubset = false;

  const reply = o.reply;
  if (!reply || !reply.ok) return;
  a.responses++;
  if (date) a.dates.response = later(a.dates.response, date);
  const top = reply.shape;
  const enveloped = top.t.includes("object") && top.k?.status?.t.join() === "boolean" && !!top.k.data && !!top.k.error;
  if (enveloped) a.enveloped++;
  else a.bare++;
  const unwrap = target.wrap && enveloped;
  if (!target.document && !target.removed) {
    flatten(unwrap ? top.k!.data! : top, "$", a.raw);
    if (target.file)
      for (const sample of reply.samples) for (const m of strictIssues(target.id, unwrap ? (sample as Any)?.data : sample, reply.typesOnly)) a.strict.add(m);
  }
}

const harPaths: string[] = [];
const logPaths: string[] = [];
for (const x of args.filter((x) => !x.startsWith("--"))) (x.endsWith(".jsonl") ? logPaths : harPaths).push(x);
if (!harPaths.length && !logPaths.length) {
  const config = join(ROOT, "scan.local.json");
  const inputs: string[] = existsSync(config) ? (JSON.parse(readFileSync(config, "utf8")).inputs ?? []) : [];
  for (const input of inputs) {
    const full = resolve(ROOT, input.replace(/^~(?=\/)/, homedir()));
    const found = [...new Bun.Glob(basename(full)).scanSync({ cwd: dirname(full) })].sort().map((f) => join(dirname(full), f));
    for (const f of found) (f.endsWith(".jsonl") ? logPaths : harPaths).push(f);
  }
  if (!harPaths.length && !logPaths.length) {
    console.error("No input files: pass .har/.jsonl paths, or list them in scan.local.json as {\"inputs\": [\"path/or/*.glob\"]}.");
    process.exit(2);
  }
}
for (const p of harPaths) {
  const har = JSON.parse(readFileSync(p, "utf8"));
  harFiles++;
  for (const e of har.log?.entries ?? []) {
    const o = fromHar(e);
    if (o) observe(o);
  }
}
for (const p of logPaths) {
  shapeLogs++;
  for (const text of readFileSync(p, "utf8").split("\n")) {
    if (!text.trim()) continue;
    let line: Any;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    const o = fromShapeLog(line);
    if (o) observe(o);
  }
}

// ---------------------------------------------------------------- labels and report

interface Change {
  file: string;
  from: Source;
  to: Source;
}
const changes: Change[] = [];
const report: string[] = [];
const diffs: { id: string; diff: Diff; notes: string[] }[] = [];
const rejected: { id: string; issues: string[] }[] = [];
const paramNotes: { id: string; extra: string[]; missing: string[] }[] = [];
let templateMatched = 0;
let withJson = 0;

for (const a of [...aggs.values()].sort((x, y) => (x.target.id < y.target.id ? -1 : 1))) {
  const t = a.target;
  if (!t.file) templateMatched++;
  const wantReq = a.qualifies;
  const wantRes = a.responses > 0 && !t.removed && !t.document;
  if (a.responses) withJson++;

  if (t.doc) {
    const missing = (t.names ?? []).filter((n) => !/[[{<]/.test(n) && !a.seenNames.has(n)).map((n) => (t.required.has(n) ? `${n}*` : n));
    if (a.extra.size || missing.length) paramNotes.push({ id: t.id, extra: [...a.extra].sort(), missing });
    const from: Source = t.doc.source ?? { request: "inferred", response: "inferred" };
    const old = observedDates(from);
    const dates: Partial<Record<Part, string>> = { ...old };
    const request: Source["request"] = wantReq ? "observed" : from.request;
    const response: Source["response"] = wantRes ? "observed" : from.response;
    if (wantReq && a.dates.request) dates.request = later(old.request, a.dates.request);
    if (wantRes && a.dates.response) dates.response = later(old.response, a.dates.response);
    for (const p of ["request", "response"] as const) if ((p === "request" ? request : response) !== "observed") delete dates[p];
    const to = makeSource(request, response, dates);
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes.push({ file: t.file!, from, to });
      if (!dryRun) writeFileSync(join(ROOT, t.file!), setSource(readFileSync(join(ROOT, t.file!), "utf8"), to));
    }
  }

  if (a.strict.size) rejected.push({ id: t.id, issues: [...a.strict].sort() });

  if (a.raw.size) {
    const shape = docShape(t.schema);
    const diff = compare(normalise(a.raw, shape), shape);
    const notes: string[] = [];
    if (t.wrap && a.bare) notes.push(`${a.bare} captured repl${a.bare === 1 ? "y" : "ies"} not wrapped in the envelope`);
    if (!t.wrap && a.enveloped) notes.push(`${a.enveloped} captured repl${a.enveloped === 1 ? "y" : "ies"} wrapped in the envelope, documented as bare`);
    if (diff.undocumented.size || diff.neverSeen.length || diff.mismatch.length || notes.length) diffs.push({ id: t.id, diff, notes });
  }
}

const count = (s: Source) => `${s.request}/${s.response}`;
const tally = new Map<string, number>();
for (const t of targets.filter((x) => x.doc)) {
  const base: Source = t.doc.source ?? { request: "inferred", response: "inferred" };
  const ch = changes.find((c) => c.file === t.file);
  const k = count(ch?.to ?? base);
  tally.set(k, (tally.get(k) ?? 0) + 1);
}

const cap = (xs: string[], n = 40) => (xs.length > n ? [...xs.slice(0, n), `... ${xs.length - n} more`] : xs);
report.push("# Observation scan", "", `${harFiles} HAR file(s), ${shapeLogs} shape log(s), ${apiRequests} requests to /ext/ or /v3/; ${aggs.size} calls matched (${templateMatched} template actions, not labelled), ${unmatched.size} unmatched request shapes. Only names and types appear here; no captured values.`, "");
report.push("## Label changes", "");
for (const c of changes) report.push(`- ${c.file.replace(/^calls\//, "")}: ${count(c.from)} -> ${count(c.to)}${c.to.observed_on ? ` (${JSON.stringify(c.to.observed_on)})` : ""}`);
if (!changes.length) report.push("None.");
report.push("", "## Parameter name differences", "", "Extra: captured but undocumented (the request is not marked observed while any exist). Missing: documented but never captured (`*` = required).", "");
for (const n of paramNotes) report.push(`- ${n.id}${n.extra.length ? `; extra: ${n.extra.join(", ")}` : ""}${n.missing.length ? `; missing: ${cap(n.missing, 15).join(", ")}` : ""}`);
if (!paramNotes.length) report.push("None.");
report.push("", "## Response structure differences", "");
for (const { id, diff, notes } of diffs) {
  report.push(`### ${id}`, "");
  for (const n of notes) report.push(`- ${n}`);
  for (const l of cap([...diff.undocumented].map(([p, t]) => `${p} (${t})`))) report.push(`- seen, undocumented: ${l}`);
  for (const m of cap(diff.mismatch)) report.push(`- type mismatch: ${m}`);
  for (const p of cap(diff.neverSeen)) report.push(`- documented, never seen: ${p}`);
  report.push("");
}
if (!diffs.length) report.push("None.", "");
report.push("## Rejected by strict validators", "", "Observed calls whose captured structure the generated strict validator refuses (the scan exits non-zero).", "");
for (const r of rejected) {
  report.push(`### ${r.id}`, "");
  for (const i of cap(r.issues, 30)) report.push(`- ${i}`);
  report.push("");
}
if (!rejected.length) report.push("None.", "");
report.push("## Unmatched API requests", "", "Possibly undocumented calls (path ids collapsed to `{id}`).", "");
for (const u of [...unmatched.values()].sort((a, b) => (a.path + a.action < b.path + b.action ? -1 : 1))) report.push(`- ${u.method} ${u.path}${u.action ? ` action=${u.action}` : ""} x${u.count}${u.names.size ? `; params: ${[...u.names].sort().join(", ")}` : ""}`);
if (!unmatched.size) report.push("None.");

const text = report.join("\n") + "\n";
if (dryRun) {
  if (!jsonOut) console.log(text);
} else {
  mkdirSync(join(ROOT, ".cache"), { recursive: true });
  writeFileSync(join(ROOT, ".cache/observation-scan.md"), text);
}
if (jsonOut) {
  console.log(
    JSON.stringify({
      hars: harFiles,
      shapeLogs,
      apiRequests,
      matched: aggs.size,
      labelChanges: changes.map((c) => ({ file: c.file.replace(/^calls\//, ""), from: count(c.from), to: count(c.to) })),
      tally: Object.fromEntries(tally),
      rejected,
      structuralDifferences: diffs.map((d) => ({
        id: d.id,
        undocumented: [...d.diff.undocumented.keys()],
        neverSeen: d.diff.neverSeen,
        mismatch: d.diff.mismatch,
        notes: d.notes,
      })),
      unmatched: [...unmatched.values()].map((u) => `${u.method} ${u.path}${u.action ? ` action=${u.action}` : ""}`),
    }),
  );
} else {
  console.log(
    `${dryRun ? "dry run: " : ""}${harFiles} HAR(s), ${shapeLogs} shape log(s), ${apiRequests} API requests, ${aggs.size} calls matched (${withJson} with a JSON reply), ${changes.length} labels ${dryRun ? "would change" : "changed"}, ${diffs.length} calls with structural differences, ${unmatched.size} unmatched request shapes${dryRun ? "" : "; report in .cache/observation-scan.md"}`,
  );
  console.log(`label tally (request/response): ${[...tally].sort().map(([k, n]) => `${k} ${n}`).join(", ")}`);
}
if (rejected.length) {
  console.error(`FAIL: ${rejected.length} observed call(s) have captured replies the strict validators reject: ${rejected.map((r) => r.id).join("; ")}`);
  process.exitCode = 1;
}
