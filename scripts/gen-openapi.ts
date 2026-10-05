import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bodyObject, envelopeOf, mapRefs, wrapExample, paramSchema as rawParamSchema } from "./lib/schema.ts";
import { observedDates, type Source } from "./lib/source.ts";
import { emitYaml, parseYaml } from "./lib/yaml.ts";

type Any = any;

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const OUT = resolve(ROOT, flag("--out", "openapi.yaml"));

const read = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), "utf8"));
const glob = (dir: string) => [...new Bun.Glob("**/*.yaml").scanSync({ cwd: join(ROOT, dir) })].sort();

const kinds = read("kinds.yaml");
const header = read("spec-header.yaml");

const schemas: Record<string, Any> = {};
for (const f of glob("schemas")) schemas[f.replace(/\.yaml$/, "")] = read(`schemas/${f}`);
const templates: Record<string, Any> = {};
for (const f of glob("templates")) templates[f.replace(/\.yaml$/, "")] = read(`templates/${f}`);

const fixRefs = <T>(n: T): T => mapRefs(n, (r) => (r.startsWith("#") ? r : `#/components/schemas/${r}`));

const ops = new Map<string, Any>();
const calls: Any[] = [];
for (const f of glob("calls")) {
  const doc = read(`calls/${f}`);
  if (f.split("/").pop()!.startsWith("_")) ops.set(`${doc.method} ${doc.path}`, doc);
  else calls.push(doc);
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const paramSchema = (p: Any): Any => fixRefs(rawParamSchema(p));

function parameters(where: "query" | "path", params: Record<string, Any> = {}): Any[] {
  return Object.entries(params).map(([name, p]) => ({
    name,
    in: where,
    required: where === "path" ? true : p.required === true,
    ...(p.description ? { description: p.description } : {}),
    schema: paramSchema(p),
  }));
}

function bodyOf(body: Any, extra: Record<string, Any> = {}): Any | undefined {
  if (!body && !Object.keys(extra).length) return undefined;
  const ct = body?.content_type ?? kinds.common.request.post_content_type;
  let schema: Any;
  let required = false;
  if (body?.schema && !Object.keys(extra).length) schema = fixRefs(body.schema);
  else {
    const params = { ...(body?.params ?? {}), ...extra };
    schema = fixRefs(bodyObject(params));
    required = Object.values<Any>(params).some((p) => p.required === true);
  }
  const media: Any = { schema };
  if (body?.example !== undefined) media.example = body.example;
  return { ...(required ? { required: true } : {}), content: { [ct]: media } };
}

function responses(call: Any, group: Any, envelopeDefault: boolean, errorRef: string): Any {
  const r = call.response ?? {};
  const out: Any = {};
  const note = typeof group?.response === "string" ? group.response : undefined;
  if (call.removed) {
    out[String(call.removed.http)] = { description: call.removed.note ?? "Removed." };
    out.default = { $ref: errorRef };
    return out;
  }
  const description = r.description ?? note ?? "Successful response.";
  const ok: Any = { description };
  if (r.document) {
    ok.content = { [r.content_type ?? "application/octet-stream"]: { schema: { type: "string", format: "binary" } } };
  } else if (r.schema || envelopeDefault || r.examples || group?.response_examples) {
    const wrap = r.envelope ?? envelopeDefault;
    const schema = r.schema ? fixRefs(r.schema) : undefined;
    const media: Any = {};
    if (wrap || schema) media.schema = wrap ? envelopeOf(schema) : schema;
    const examples = r.examples ?? group?.response_examples;
    if (examples) {
      media.examples = Object.fromEntries(
        Object.entries(examples).map(([k, e]: Any) => [k, { ...(e.summary ? { summary: e.summary } : {}), value: wrap ? wrapExample(k, e.value) : e.value }]),
      );
    }
    if (Object.keys(media).length) ok.content = { [kinds.common.response.content_type]: media };
  }
  out["200"] = ok;
  out.default = { $ref: errorRef };
  return out;
}

const INFERRED: Source = { request: "inferred", response: "inferred" };

function sourceLine(s: Source): string {
  const dates = observedDates(s);
  const say = (part: "request" | "response") => {
    const v = s[part];
    if (v === "observed") return `observed in captured traffic${dates[part] && dates[part] !== "unknown" ? `, ${dates[part]}` : ""}`;
    return v === "inferred" ? "inferred from the web app's code" : "not read by the web app's code";
  };
  return `Request: ${say("request")}. Response: ${say("response")}.`;
}

function describe(call: Any, group: Any): string | undefined {
  const parts: string[] = [];
  const main = call.description ?? group?.description;
  if (main) parts.push(String(main).trimEnd());
  if (call.notes) parts.push(String(call.notes).trimEnd());
  if (call.removed) parts.push(`Removed: HTTP ${call.removed.http}.${call.removed.note ? ` ${call.removed.note}` : ""}`);
  if (typeof call.deprecated === "string") parts.push(`Deprecated: ${call.deprecated}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

type Built = { path: string; method: string; op: Any; tag?: string; idBase: string };
const built: Built[] = [];

const sanitize = (s: string) => s.replace(/\{([^}]+)\}/g, "By_$1").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

function add(call: Any, a: { method: string; action?: string; summary?: string; actionDef?: Any; extraQuery?: Record<string, Any>; extraBody?: Record<string, Any> }) {
  const def = a.actionDef ?? call;
  const method = a.method.toLowerCase();
  const v3 = call.kind === "v3-route";
  const group = ops.get(`${a.method} ${call.path}`);
  const params: Any[] = [];
  if (a.action) params.push({ name: "action", in: "query", required: true, schema: { type: "string", enum: [a.action] } });
  params.push(...parameters("path", call.path_params));
  const query = { ...(def.query ?? {}), ...(a.extraQuery ?? {}) };
  if (a.action) delete query.action;
  params.push(...parameters("query", query));

  const group2 = group && (a.actionDef ? undefined : group);
  const op: Any = { summary: def.summary ?? group?.summary };
  const source: Source = call.source ?? INFERRED;
  const desc = describe({ ...def, removed: call.removed, deprecated: call.deprecated, notes: def.notes, description: def.description }, group2);
  op.description = [sourceLine(source), desc].filter(Boolean).join("\n\n");
  if (call.tags?.length) op.tags = call.tags;
  if (call.removed || call.deprecated) op.deprecated = true;
  op["x-source"] = source;
  if (params.length) op.parameters = params;
  const rb = bodyOf(def.body ?? (a.extraBody ? {} : undefined), a.extraBody);
  if (rb && method !== "get") op.requestBody = rb;
  if (group?.request_examples && rb && !a.actionDef) {
    const media = Object.values<Any>(rb.content)[0];
    if (media.example === undefined) media.examples = Object.fromEntries(Object.entries(group.request_examples).map(([k, v]) => [k, { value: v }]));
  }
  op.responses = responses({ ...def, removed: call.removed }, group2, v3 ? kinds.kinds["v3-route"].envelope !== false : false, v3 ? "#/components/responses/V3Error" : "#/components/responses/ExtError");

  const key = a.action ? `${call.path}?action=${a.action}` : call.path;
  const idBase = sanitize(a.action ? `${call.path}_${a.action}` : v3 ? `${call.path}` : call.path);
  built.push({ path: key, method, op, tag: call.tags?.[0], idBase: v3 ? `${method}_${idBase}` : idBase });
}

for (const call of calls) {
  if (call.uses) {
    const t = templates[call.uses.template];
    const prefix: string | undefined = call.uses.prefix;
    for (const [name, def] of Object.entries<Any>(t.actions)) {
      const action = prefix ? prefix + name : lowerFirst(name);
      // The template description says context params go in the query for these four and in the body otherwise.
      const inQuery = ["Config", "Manifest", "Put", "PartPut"].includes(name);
      add(call, { method: def.method, action, actionDef: { ...def, tags: call.tags }, extraQuery: inQuery ? call.uses.params : undefined, extraBody: inQuery ? undefined : call.uses.params });
    }
  } else add(call, { method: call.method, action: call.action });
}

const ids = new Map<string, number>();
for (const b of built) ids.set(b.idBase, (ids.get(b.idBase) ?? 0) + 1);
for (const b of built) b.op.operationId = ids.get(b.idBase)! > 1 && !b.idBase.startsWith(b.method + "_") ? `${b.idBase}_${b.method}` : b.idBase;
const seenIds = new Set<string>();
for (const b of built) {
  if (seenIds.has(b.op.operationId)) throw new Error(`duplicate operationId ${b.op.operationId}`);
  seenIds.add(b.op.operationId);
}

const tagOrder = new Map<string, number>(header.tags.map((t: Any, i: number) => [t.name, i]));
const usedTags = new Set(built.flatMap((b) => b.op.tags ?? []));
const extraTags = [...new Set(built.map((b) => b.tag).filter((t): t is string => !!t && !tagOrder.has(t)))].sort();
extraTags.forEach((t, i) => tagOrder.set(t, header.tags.length + i));
const rank = (t?: string) => (t === undefined ? 1e6 : (tagOrder.get(t) ?? 1e6));

const methodOrder = ["get", "post"];
built.sort((a, b) => rank(a.tag) - rank(b.tag) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || methodOrder.indexOf(a.method) - methodOrder.indexOf(b.method));

const paths: Any = {};
for (const b of built) (paths[b.path] ??= {})[b.method] = b.op;

const kindNotes = () => {
  const c = kinds.common;
  const lines = [
    "## Request and response conventions",
    "",
    `Every call sends \`X-CSRF\`: ${c.request.headers["X-CSRF"]}`,
    `POST bodies are \`${c.request.post_content_type}\`, or \`multipart/form-data\` for file uploads.`,
    `Replies are \`${c.response.content_type}\`. Rate-limit headers: ${c.response.rate_limit_headers.map((h: string) => `\`${h}\``).join(", ")}; ${c.response.on_limit}. Also watch ${c.response.watch_headers.map((h: string) => `\`${h}\``).join(", ")}.`,
    "",
    "Each operation starts with where its docs come from, and carries it as `x-source`. `observed`: seen in captured traffic, with the date. `inferred`: worked out from the web app's JavaScript (request parameters from its calls, response fields from what it reads). `unknown` (response only): the web app never reads the reply.",
    "",
  ];
  for (const [name, k] of Object.entries<Any>(kinds.kinds)) {
    lines.push(`**\`${name}\`** — ${k.description} Route: ${k.route}.`);
    lines.push(typeof k.envelope === "object" ? `Replies are wrapped as \`{ status, error, data, meta }\`; errors are \`${k.error.error}\`.` : `Replies are not wrapped by default; errors are ${k.error.error}.`);
    lines.push(k.note, "");
  }
  lines.push("Operations under `/ext/<module>/?action=<name>` list each action separately; the `?action=` part is not an OpenAPI path template, it is the required `action` query parameter.");
  return lines.join("\n");
};

const errorComponents = {
  V3Error: {
    description: "Failure reply, with the HTTP status of the failure.",
    content: { "application/json": { schema: { type: "object", properties: { status: { type: "boolean", enum: [false] }, error: { type: "object", properties: { message: { type: "string" }, code: {} } }, data: { type: "object", nullable: true }, meta: { nullable: true, type: "object" } } } } },
  },
  ExtError: {
    description: "Failure reply; `error` is a `{ message }` object or a plain string.",
    content: { "application/json": { schema: { type: "object", properties: { status: { type: "boolean", enum: [false] }, error: { oneOf: [{ type: "object", properties: { message: { type: "string" } } }, { type: "string" }] } } } } },
  },
};

const refsOf = (n: unknown) => [...JSON.stringify(n).matchAll(/#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
const reachable = new Set<string>();
for (const queue = refsOf(paths); queue.length; ) {
  const n = queue.pop()!;
  if (reachable.has(n) || !schemas[n]) continue;
  reachable.add(n);
  queue.push(...refsOf(fixRefs(schemas[n])));
}

const spec = {
  openapi: "3.0.3",
  info: { ...header.info, description: `${String(header.info.description).trimEnd()}\n\n${kindNotes()}\n` },
  servers: header.servers,
  security: header.security,
  tags: [...header.tags.filter((t: Any) => usedTags.has(t.name)), ...extraTags.map((name) => ({ name }))],
  paths,
  components: {
    securitySchemes: header.securitySchemes,
    responses: errorComponents,
    schemas: Object.fromEntries(Object.keys(schemas).sort().filter((n) => reachable.has(n)).map((n) => [n, fixRefs(schemas[n])])),
  },
};

writeFileSync(OUT, emitYaml(spec));
console.log(`wrote ${OUT}: ${built.length} operations, ${Object.keys(paths).length} paths, ${Object.keys(spec.components.schemas).length} schemas`);
