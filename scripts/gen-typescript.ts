// Generates clients/typescript/src/index.ts (zod v4 validators + typed call registry) from calls/, schemas/, templates/.
// Usage: bun scripts/gen-typescript.ts [--out <file>] [--strict-all]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { refsIn } from "./lib/schema.ts";
import { segments } from "./lib/layout.ts";
import { observedDates, type Source } from "./lib/source.ts";
import { parseYaml } from "./lib/yaml.ts";

type Any = any;
type Mode = "lenient" | "strict";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const outPath = resolve(ROOT, argv.includes("--out") ? argv[argv.indexOf("--out") + 1]! : "clients/typescript/src/index.ts");
const strictAll = argv.includes("--strict-all");

const read = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), "utf8"));
const files = (dir: string) => [...new Bun.Glob("**/*.yaml").scanSync({ cwd: join(ROOT, dir) })].sort();

const schemas: Record<string, Any> = {};
for (const f of files("schemas")) schemas[f.replace(/\.yaml$/, "")] = read(`schemas/${f}`);
const templates: Record<string, Any> = {};
for (const f of files("templates")) templates[f.replace(/\.yaml$/, "")] = read(`templates/${f}`);

const IDENT = /^[A-Za-z_$][\w$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const lit = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------- schema -> zod

const deps = new Map<string, Set<string>>();
for (const [n, s] of Object.entries(schemas)) deps.set(n, refsIn(s));

// Tarjan SCC; a schema is recursive when its component has >1 member or it refs itself.
const comp = new Map<string, number>();
const recursive = new Set<string>();
{
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  let c = 0;
  const visit = (v: string) => {
    index.set(v, idx);
    low.set(v, idx++);
    stack.push(v);
    on.add(v);
    for (const w of deps.get(v) ?? []) {
      if (!deps.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const members: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        comp.set(w, c);
        members.push(w);
      } while (w !== v);
      if (members.length > 1 || deps.get(v)!.has(v)) members.forEach((m) => recursive.add(m));
      c++;
    }
  };
  for (const n of deps.keys()) if (!index.has(n)) visit(n);
}

const variantName = (name: string, mode: Mode) => (mode === "strict" ? `${name}Strict` : name);

interface Emitted {
  expr: string;
  refs: Set<string>; // variant names this expression uses eagerly (not via z.lazy)
}
const emitted = new Map<string, Emitted>();
const variants = new Map<string, [string, Mode]>();
const queue: [string, Mode][] = [];

function useSchema(name: string, mode: Mode, from: string | undefined, eager: Set<string>): string {
  if (!(name in schemas)) throw new Error(`unknown schema ${name}`);
  const v = variantName(name, mode);
  if (!emitted.has(v)) {
    emitted.set(v, { expr: "", refs: new Set() });
    variants.set(v, [name, mode]);
    queue.push([name, mode]);
  }
  if (from !== undefined && recursive.has(name) && comp.get(name) === comp.get(from)) return `z.lazy(() => ${v})`;
  eager.add(v);
  return v;
}

interface Ctx {
  mode: Mode;
  from?: string;
  eager: Set<string>;
}

const typeOf = (n: Any): string[] => (Array.isArray(n.type) ? n.type : n.type ? [n.type] : []);

function zod(node: Any, cx: Ctx): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "z.unknown()";
  const lenient = cx.mode === "lenient";
  let e: string;
  let nullable = node.nullable === true;
  const types = typeOf(node);
  if (types.includes("null")) nullable = true;
  const real = types.filter((t) => t !== "null");

  if (node.$ref) e = useSchema(node.$ref, cx.mode, cx.from, cx.eager);
  else if (Array.isArray(node.allOf) && node.allOf.length) {
    const parts = node.allOf.map((b: Any) => zod(b, cx));
    e = parts.reduce((a: string, b: string) => `z.intersection(${a}, ${b})`);
  } else if ((node.oneOf ?? node.anyOf)?.length) {
    const parts: string[] = (node.oneOf ?? node.anyOf).map((b: Any) => zod(b, cx));
    e = parts.length === 1 ? parts[0]! : `z.union([${parts.join(", ")}])`;
  } else if (Array.isArray(node.enum) && node.enum.length && !lenient) {
    e = node.enum.every((v: unknown) => typeof v === "string") ? `z.enum([${node.enum.map(lit).join(", ")}])` : `z.union([${node.enum.map((v: unknown) => `z.literal(${lit(v)})`).join(", ")}])`;
  } else {
    const t = real[0] ?? (node.properties || node.additionalProperties !== undefined ? "object" : node.items ? "array" : undefined);
    if (real.length > 1) e = `z.union([${real.map((r) => zod({ ...node, type: r, nullable: false }, cx)).join(", ")}])`;
    else
      switch (t) {
        case "string":
          e = "z.string()";
          break;
        case "integer":
        case "number":
          e = "z.number()";
          break;
        case "boolean":
          e = "z.boolean()";
          break;
        case "array":
          e = `z.array(${zod(node.items, cx)})`;
          break;
        case "object":
          e = objectExpr(node, cx);
          break;
        default:
          e = "z.unknown()";
      }
  }
  return nullable && e !== "z.unknown()" ? `${e}.nullable()` : e;
}

function objectExpr(node: Any, cx: Ctx): string {
  const lenient = cx.mode === "lenient";
  const props: Record<string, Any> = node.properties && typeof node.properties === "object" ? node.properties : {};
  const required = new Set<string>(Array.isArray(node.required) ? node.required : []);
  const ap = node.additionalProperties;
  const names = Object.keys(props);
  if (!names.length) {
    const v = ap && typeof ap === "object" ? zod(ap, cx) : "z.unknown()";
    return `php(z.record(z.string(), ${lenient && v !== "z.unknown()" ? `lax(${v})` : v}))`;
  }
  const shape = names
    .map((k) => {
      const c = zod(props[k], cx);
      const isUnknown = c === "z.unknown()";
      const v = isUnknown ? "z.unknown().optional()" : lenient ? `lax(${c})` : required.has(k) ? c : `${c}.optional()`;
      return `${key(k)}: ${v}`;
    })
    .join(", ");
  if (lenient || ap === true) return `php(z.looseObject({ ${shape} }))`;
  if (ap && typeof ap === "object") return `php(z.object({ ${shape} }).catchall(${zod(ap, cx)}))`;
  return `php(z.object({ ${shape} }))`;
}

// ---------------------------------------------------------------- params -> TS types

const FILE = "FileValue";

function tsType(p: Any): string {
  if (!p || typeof p !== "object") return "string | number";
  if (p.$ref) return p.$ref;
  let t: string;
  if (Array.isArray(p.enum) && p.enum.length) t = p.enum.map(lit).join(" | ");
  else
    switch (typeOf(p).find((x) => x !== "null")) {
      case "string":
        t = p.format === "binary" ? FILE : "string";
        break;
      case "integer":
      case "number":
        t = "number";
        break;
      case "boolean":
        t = "boolean";
        break;
      case "array":
        t = `Array<${tsType(p.items ?? {})}>`;
        break;
      case "object": {
        const props = p.properties;
        if (props && typeof props === "object") {
          const req = new Set<string>(Array.isArray(p.required) ? p.required : []);
          t = `{ ${Object.entries(props).map(([k, v]) => `${key(k)}${req.has(k) ? "" : "?"}: ${tsType(v)}`).join("; ")}; [k: string]: unknown }`;
        } else t = "Record<string, unknown>";
        break;
      }
      default:
        t = p.oneOf || p.anyOf ? (p.oneOf ?? p.anyOf).map(tsType).join(" | ") : "string | number";
    }
  return p.nullable ? `${t} | null` : t;
}

function paramsType(params: Record<string, Any> | undefined, allRequired = false): string {
  const entries = Object.entries(params ?? {});
  if (!entries.length) return "undefined";
  return `{ ${entries.map(([k, v]) => `${key(k)}${allRequired || v?.required === true ? "" : "?"}: ${tsType(v)}`).join("; ")} }`;
}

// ---------------------------------------------------------------- calls

interface Call {
  file: string;
  kind: "ext-action" | "v3-route";
  method: "GET" | "POST";
  path: string;
  action?: string;
  summary?: string;
  deprecated?: boolean | string;
  removed?: { http: number; note?: string };
  source: Source;
  pathParams?: Record<string, Any>;
  query?: Record<string, Any>;
  bodyParams?: Record<string, Any>;
  bodySchema?: Any;
  multipart: boolean;
  response?: Any;
}

const calls: Call[] = [];
const BODY_CTX = new Set(["CommitTemp", "RevertTemp"]);
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

for (const f of files("calls")) {
  if (f.split("/").pop()!.startsWith("_")) continue;
  const d = read(`calls/${f}`);
  if (!d?.path) continue;
  const base = { file: f, kind: d.kind, path: d.path, deprecated: d.deprecated, removed: d.removed, source: d.source ?? { request: "inferred", response: "inferred" } };
  if (d.uses) {
    const t = templates[d.uses.template];
    if (!t) throw new Error(`${f}: unknown template ${d.uses.template}`);
    const prefix: string = d.uses.prefix ?? "";
    const ctx: Record<string, Any> = d.uses.params ?? {};
    for (const [name, a] of Object.entries<Any>(t.actions)) {
      const action = prefix ? prefix + name : lcFirst(name);
      const inBody = BODY_CTX.has(name);
      calls.push({
        ...base,
        method: a.method,
        action,
        summary: a.summary,
        query: { ...(inBody ? {} : ctx), ...(a.query ?? {}) },
        bodyParams: { ...(inBody ? ctx : {}), ...(a.body?.params ?? {}) },
        bodySchema: a.body?.schema,
        multipart: a.body?.content_type === "multipart/form-data",
        response: a.response,
      });
    }
    continue;
  }
  calls.push({
    ...base,
    method: d.method,
    action: d.action,
    summary: d.summary,
    pathParams: d.path_params,
    query: d.query,
    bodyParams: d.body?.params,
    bodySchema: d.body?.schema,
    multipart: d.body?.content_type === "multipart/form-data",
    response: typeof d.response === "object" ? d.response : undefined,
  });
}

// ---------------------------------------------------------------- naming

const camel = (s: string) => s.replace(/[-.](\w)/g, (_, c: string) => c.toUpperCase()).replace(/[^\w$]/g, "_").replace(/^(\d)/, "_$1");
const segName = (s: string) => (s.startsWith("{") ? "$" + camel(s.slice(1, -1)) : camel(s));

interface Tree {
  [k: string]: Tree | Call;
}
const isCall = (n: Tree | Call): n is Call => "method" in n && "path" in n && typeof (n as Call).path === "string";

function groupPath(c: Call): string[] {
  return segments(c.path).slice(1).map(segName);
}

const tree: Tree = {};
const pathOf = new Map<Call, string>();
{
  const byLeaf = new Map<string, Call[]>();
  const leafBase = (c: Call) => (c.kind === "v3-route" ? c.method.toLowerCase() : c.action ? camel(c.action) : c.method.toLowerCase());
  const fullKey = (c: Call, leaf: string) => [c.kind === "v3-route" ? "v3" : "", ...groupPath(c), leaf].filter(Boolean).join("/");
  for (const c of calls) {
    const k = fullKey(c, leafBase(c));
    byLeaf.set(k, [...(byLeaf.get(k) ?? []), c]);
  }
  const taken = new Set<string>();
  const groups = new Set<string>();
  for (const c of calls) {
    const g = [c.kind === "v3-route" ? "v3" : "", ...groupPath(c)].filter(Boolean);
    for (let i = 1; i <= g.length; i++) groups.add(g.slice(0, i).join("/"));
  }
  for (const c of calls) {
    let leaf = leafBase(c);
    const dup = byLeaf.get(fullKey(c, leaf))!.length > 1;
    if (dup && c.kind === "ext-action") leaf += c.method === "GET" ? "Get" : "Post";
    let k = fullKey(c, leaf);
    while (groups.has(k) || taken.has(k)) {
      leaf += "Call";
      k = fullKey(c, leaf);
    }
    taken.add(k);
    const path = k.split("/");
    let n = tree;
    for (const p of path.slice(0, -1)) n = (n[p] ??= {}) as Tree;
    n[path.at(-1)!] = c;
    pathOf.set(c, path.join("."));
  }
}

// ---------------------------------------------------------------- emit calls

const doc = (c: Call): string => {
  const lines: string[] = [];
  if (c.summary) lines.push(c.summary.replace(/\*\//g, "* /").replace(/\s+/g, " ").trim());
  if (c.removed) lines.push(`@deprecated Removed: HTTP ${c.removed.http}${c.removed.note ? `, ${c.removed.note.replace(/\*\//g, "* /").replace(/\s+/g, " ")}` : ""}`);
  else if (c.deprecated) lines.push(`@deprecated${typeof c.deprecated === "string" ? " " + c.deprecated.replace(/\*\//g, "* /").replace(/\s+/g, " ") : ""}`);
  return lines.length ? `/** ${lines.join(" ")} */\n` : "";
};

const sourceLit = (s: Source): string => {
  const dates = Object.fromEntries(Object.entries(observedDates(s)).filter(([, d]) => d !== "unknown"));
  return JSON.stringify({ request: s.request, response: s.response, ...(Object.keys(dates).length ? { observedOn: dates } : {}) });
};

const callId = (c: Call) => `${c.method} ${c.path}${c.action ? `?action=${c.action}` : ""}`;

function callExpr(c: Call, indent: string): string {
  const mode: Mode = strictAll || c.source.response === "observed" ? "strict" : "lenient";
  const r = c.response;
  const envelope = c.kind === "v3-route" ? r?.envelope !== false : r?.envelope === true;
  const eager = new Set<string>();
  let response: string;
  if (r?.document) response = `{ document: true${r.content_type ? `, contentType: ${lit(r.content_type)}` : ""} }`;
  else {
    const z = r?.schema ? zod(r.schema, { mode, eager }) : "z.unknown()";
    response = `{ data: ${mode === "lenient" ? `lax(${z})` : z}, envelope: ${envelope}, strict: ${mode === "strict"} }`;
  }
  const pathParams = c.pathParams && Object.keys(c.pathParams).length ? paramsType(c.pathParams, true) : "undefined";
  const bodyT = c.bodySchema ? tsType(c.bodySchema) : paramsType(c.bodyParams);
  const fields = [
    `id: ${lit(callId(c))}`,
    `kind: ${lit(c.kind)}`,
    `method: ${lit(c.method)}`,
    `path: ${lit(c.path)}`,
    ...(c.action ? [`action: ${lit(c.action)}`] : []),
    `source: ${sourceLit(c.source)}`,
    ...(c.removed ? [`removed: ${JSON.stringify(c.removed)}`] : []),
    ...(c.deprecated ? [`deprecated: ${typeof c.deprecated === "string" ? lit(c.deprecated) : "true"}`] : []),
    ...(c.multipart ? [`contentType: "multipart/form-data"`] : []),
    `params: p<${pathParams}, ${paramsType(c.query)}, ${bodyT}>()`,
    `response: ${response}`,
  ];
  const pad = indent + "  ";
  return `defineCall({\n${fields.map((x) => pad + x).join(",\n")},\n${indent}})`;
}

function emitTree(n: Tree, indent: string): string {
  const pad = indent + "  ";
  let out = "{\n";
  for (const [k, v] of Object.entries(n)) {
    if (isCall(v)) out += `${doc(v) ? pad + doc(v) : ""}${pad}${key(k)}: ${callExpr(v, pad)},\n`;
    else out += `${pad}${key(k)}: ${emitTree(v, pad)},\n`;
  }
  return out + `${indent}}`;
}

const treeCode = emitTree(tree, "");

// ---------------------------------------------------------------- emit schemas

// Every lenient shared schema is emitted; strict variants only when an observed call needs them.
for (const n of Object.keys(schemas)) useSchema(n, "lenient", undefined, new Set());
while (queue.length) {
  const [name, mode] = queue.shift()!;
  const eager = new Set<string>();
  const expr = zod(schemas[name], { mode, from: name, eager });
  emitted.set(variantName(name, mode), { expr, refs: eager });
}

const order: string[] = [];
{
  const seen = new Set<string>();
  const visit = (v: string) => {
    if (seen.has(v)) return;
    seen.add(v);
    for (const d of emitted.get(v)!.refs) visit(d);
    order.push(v);
  };
  [...emitted.keys()].sort().forEach(visit);
}

const schemaCode = order
  .map((v) => {
    const e = emitted.get(v)!;
    const isRec = recursive.has(variants.get(v)![0]);
    const decl = isRec ? `export const ${v}: z.ZodType = ${e.expr};` : `export const ${v} = ${e.expr};`;
    return `${decl}\nexport type ${v} = z.output<typeof ${v}>;`;
  })
  .join("\n");

// ---------------------------------------------------------------- prelude

const PRELUDE = `import { z } from "zod";

// PHP serialises an empty map as [].
const php = <T extends z.ZodType>(s: T) => z.preprocess((v) => (Array.isArray(v) && v.length === 0 ? {} : v), s);
// A wrong guess about a field costs that field (undefined), never a thrown error.
const lax = <T extends z.ZodType>(s: T) => s.optional().catch(undefined).optional();

/** A file in a multipart upload. */
export type FileValue = Uint8Array | ArrayBuffer | { readonly size: number; readonly type: string };

export interface ErrorBody {
  message?: string;
  code?: string | number;
  [k: string]: unknown;
}

/** Full reply body of a call that uses the status/error/data/meta wrapper. */
export type Envelope<D extends z.ZodType> = z.ZodType<{
  status?: boolean;
  error?: string | ErrorBody | null;
  data?: z.output<D>;
  meta?: unknown;
  [k: string]: unknown;
}>;

const errorBody = z.union([z.string(), z.looseObject({ message: lax(z.string()), code: lax(z.union([z.string(), z.number()])) })]);

function envelopeOf<D extends z.ZodType>(data: D, strict: boolean): Envelope<D> {
  return z.looseObject({
    status: strict ? z.boolean() : lax(z.boolean()),
    error: lax(errorBody.nullable()),
    data: strict ? data.optional() : lax(data),
    meta: z.unknown().optional(),
  }) as unknown as Envelope<D>;
}

export interface Params<P, Q, B> {
  readonly _path?: P;
  readonly _query?: Q;
  readonly _body?: B;
}
const p = <P, Q, B>(): Params<P, Q, B> => ({});

export interface JsonResponse<R extends z.ZodType, E extends boolean> {
  /** Validator for the data payload. */
  readonly data: R;
  /** Whether the reply is wrapped in status/error/data/meta. */
  readonly envelope: E;
  /** Validator for the whole reply body. */
  readonly body: E extends true ? Envelope<R> : R;
}
export interface DocumentResponse {
  readonly document: true;
  readonly contentType?: string;
  readonly body: null;
}
type ResponseSpec = { data: z.ZodType; envelope: boolean; strict: boolean } | { document: true; contentType?: string };

export interface Call<P, Q, B, Res> {
  readonly id: string;
  readonly kind: "ext-action" | "v3-route";
  readonly method: "GET" | "POST";
  /** Path template; v3 routes keep {name} segments. */
  readonly path: string;
  /** ext-action calls: the \`action\` query parameter. */
  readonly action?: string;
  /** Where the docs come from; \`observedOn\` is set for observed parts whose date is known. */
  readonly source: {
    readonly request: "observed" | "inferred";
    readonly response: "observed" | "inferred" | "unknown";
    readonly observedOn?: { readonly request?: string; readonly response?: string };
  };
  readonly deprecated?: boolean | string;
  readonly removed?: { readonly http: number; readonly note?: string };
  /** Request body encoding when not form-urlencoded. */
  readonly contentType?: "multipart/form-data";
  readonly response: Res;
  readonly params?: Params<P, Q, B>;
}
export type AnyCall = Call<any, any, any, JsonResponse<z.ZodType, boolean> | DocumentResponse>;

export function defineCall<P, Q, B, R extends z.ZodType, E extends boolean>(
  spec: Omit<Call<P, Q, B, unknown>, "response"> & { response: { data: R; envelope: E; strict: boolean } },
): Call<P, Q, B, JsonResponse<R, E>>;
export function defineCall<P, Q, B>(
  spec: Omit<Call<P, Q, B, unknown>, "response"> & { response: { document: true; contentType?: string } },
): Call<P, Q, B, DocumentResponse>;
export function defineCall(spec: Omit<Call<any, any, any, unknown>, "response"> & { response: ResponseSpec }): unknown {
  const r = spec.response;
  if ("document" in r) return { ...spec, response: { ...r, body: null } };
  return { ...spec, response: { data: r.data, envelope: r.envelope, body: r.envelope ? envelopeOf(r.data, r.strict) : r.data } };
}

type Keys<T> = T extends undefined ? never : T;
type Part<K extends string, T> = [T] extends [undefined] ? {} : {} extends Keys<T> ? { [P in K]?: Keys<T> } : { [P in K]: Keys<T> };

/** Arguments for a call: \`path\`, \`query\` and \`body\`, each present only when the call takes any. */
export type CallArgs<C extends AnyCall> = C extends Call<infer P, infer Q, infer B, any> ? Part<"path", P> & Part<"query", Q> & Part<"body", B> : never;
/** Validated data payload (the \`data\` field for wrapped replies). */
export type CallData<C extends AnyCall> = C["response"] extends JsonResponse<infer R, any> ? z.output<R> : unknown;
/** Validated full reply body. */
export type CallBody<C extends AnyCall> = C["response"] extends { body: infer V extends z.ZodType } ? z.output<V> : unknown;

export interface HttpRequest {
  method: "GET" | "POST";
  /** Path with {name} segments already filled in. */
  path: string;
  query?: Record<string, string>;
  form?: Record<string, string | FileValue>;
  multipart?: boolean;
}
export interface HttpClient {
  request(req: HttpRequest): Promise<unknown>;
}

const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v));

function fields(src: Record<string, unknown> | undefined, keepFiles: boolean): Record<string, string | FileValue> {
  const out: Record<string, string | FileValue> = {};
  for (const [k, v] of Object.entries(src ?? {})) {
    if (keepFiles && v && typeof v === "object" && !Array.isArray(v) && ("size" in v || v instanceof Uint8Array || v instanceof ArrayBuffer)) out[k] = v as FileValue;
    else {
      const s = str(v);
      if (s !== undefined) out[k] = s;
    }
  }
  return out;
}

/** Pure: turns a call and its arguments into the request to send. */
export function buildRequest<C extends AnyCall>(call: C, args?: { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: Record<string, unknown> }): HttpRequest {
  const path = call.path.replace(/\\{([^}]+)\\}/g, (_, name: string) => {
    const v = args?.path?.[name];
    if (v === undefined) throw new Error(\`Missing path parameter \${name} for \${call.id}\`);
    return encodeURIComponent(String(v));
  });
  const query = fields(args?.query, false) as Record<string, string>;
  const req: HttpRequest = { method: call.method, path, query: call.action ? { action: call.action, ...query } : query };
  if (args?.body) {
    req.form = fields(args.body, true);
    if (call.contentType) req.multipart = true;
  }
  return req;
}

type ArgsTuple<C extends AnyCall> = {} extends CallArgs<C> ? [args?: CallArgs<C>] : [args: CallArgs<C>];

/** Sends the call through \`http\` and validates the reply; lenient validators never throw. */
export async function call<C extends AnyCall>(http: HttpClient, c: C, ...rest: ArgsTuple<C>): Promise<CallBody<C>> {
  const json = await http.request(buildRequest(c, rest[0] as Parameters<typeof buildRequest>[1]));
  const body = c.response.body as z.ZodType | null;
  return (body ? body.parse(json) : json) as CallBody<C>;
}

/** Every call in the registry, flattened. */
export function allCalls(): AnyCall[] {
  const out: AnyCall[] = [];
  const walk = (n: object) => {
    for (const v of Object.values(n)) {
      if (v && typeof v === "object") {
        if ("kind" in v && "path" in v && "response" in v) out.push(v as AnyCall);
        else walk(v);
      }
    }
  };
  walk(OsmApi);
  return out;
}
`;

const out = `// Generated by scripts/gen-typescript.ts from calls/, schemas/ and templates/. Do not edit.
${PRELUDE}
export const OSM_API_VERSION = ${JSON.stringify(read("spec-header.yaml").info.version)};

// ---- Shared response schemas

${schemaCode}

// ---- Call registry: OsmApi.<area>.<action> for /ext calls, OsmApi.v3.<route>.<get|post> for /v3 routes

export const OsmApi = ${treeCode} as const;
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);
const strictCount = calls.filter((c) => strictAll || c.source.response === "observed").length;
console.log(
  `${outPath}: ${calls.length} calls (${strictCount} strict), ${Object.keys(schemas).length} schemas (${recursive.size} recursive), ${(out.length / 1024).toFixed(0)} KiB`,
);
