import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import { baseNames, callDir, callId, segments } from "./lib/layout.ts";
import { bodyObject, compile, envelopeOf, makeAjv, refsIn, wrapExample } from "./lib/schema.ts";
import { observedDates } from "./lib/source.ts";
import { parseYaml } from "./lib/yaml.ts";

type Any = any;

const ROOT = resolve(import.meta.dir, "..");
const withExamples = process.argv.includes("--examples");
const errors: string[] = [];
const warnings: string[] = [];
const fail = (file: string, msg: string) => errors.push(`${file}: ${msg}`);

const read = (rel: string) => parseYaml(readFileSync(join(ROOT, rel), "utf8"));
const files = (dir: string) => [...new Bun.Glob("**/*.yaml").scanSync({ cwd: join(ROOT, dir) })].sort().map((f) => `${dir}/${f}`);

const format = JSON.parse(readFileSync(join(ROOT, "format.schema.json"), "utf8"));
const fmt = new Ajv({ strict: false, allErrors: true });
fmt.addSchema(format, "fmt");
const validator = (def: string) => fmt.getSchema(`fmt#/$defs/${def}`)!;
const check = (def: string, file: string, doc: unknown) => {
  const v = validator(def);
  if (!v(doc)) for (const e of v.errors ?? []) fail(file, `${e.instancePath || "/"} ${e.message}`);
};

check("kinds", "kinds.yaml", read("kinds.yaml"));
const kindsDoc = read("kinds.yaml");
const kinds = new Set(Object.keys(kindsDoc.kinds ?? {}));

const schemas: Record<string, Any> = {};
for (const f of files("schemas")) {
  const name = f.replace(/^schemas\//, "").replace(/\.yaml$/, "");
  schemas[name] = read(f);
  if (typeof schemas[name] !== "object" || schemas[name] === null) fail(f, "not a schema object");
}

const templates: Record<string, Any> = {};
for (const f of files("templates")) {
  const doc = read(f);
  check("template", f, doc);
  templates[f.replace(/^templates\//, "").replace(/\.yaml$/, "")] = doc;
}

const refUse = new Map<string, number>();
const checkRefs = (file: string, doc: unknown) => {
  for (const r of refsIn(doc)) {
    refUse.set(r, (refUse.get(r) ?? 0) + 1);
    if (!(r in schemas)) fail(file, `$ref "${r}" has no schemas/${r}.yaml`);
  }
};

const seen = new Map<string, string>();
const calls: { file: string; doc: Any }[] = [];
for (const f of files("calls")) {
  const doc = read(f);
  const base = f.split("/").pop()!.replace(/\.yaml$/, "");
  if (base.startsWith("_")) {
    check("op", f, doc);
    if (doc?.path && f !== `${callDir(doc.path)}/_${String(doc.method).toLowerCase()}.yaml`) fail(f, "file location does not match path and method");
    checkRefs(f, doc);
    continue;
  }
  check("call", f, doc);
  if (!doc?.path) continue;
  calls.push({ file: f, doc });
  const dir = f.split("/").slice(0, -1).join("/");
  if (dir !== callDir(doc.path)) fail(f, `directory should be ${callDir(doc.path)}`);
  if (!baseNames(doc).includes(base)) fail(f, `file name should be one of ${baseNames(doc).join(", ")}`);
  if (!kinds.has(doc.kind)) fail(f, `unknown kind ${doc.kind}`);
  if (doc.source) {
    const dates = observedDates(doc.source);
    for (const p of ["request", "response"] as const) if (doc.source[p] === "observed" && !dates[p]) fail(f, `source.${p} is observed but has no observed_on date`);
  }
  const id = callId(doc);
  if (seen.has(id)) fail(f, `duplicate call, also ${seen.get(id)}`);
  seen.set(id, f);

  const braces = [...doc.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
  const declaredParams = Object.keys(doc.path_params ?? {}).sort();
  if (doc.uses) {
    const t = templates[doc.uses.template];
    if (!t) fail(f, `unknown template ${doc.uses.template}`);
  } else if (braces.join() !== declaredParams.join()) fail(f, `path_params [${declaredParams}] do not match path segments [${braces}]`);
  if (doc.kind === "v3-route" && segments(doc.path)[0] !== "v3") fail(f, "v3-route path must start with /v3/");
  checkRefs(f, doc);
}
for (const [name, t] of Object.entries(templates)) checkRefs(`templates/${name}.yaml`, t);
for (const [name, s] of Object.entries(schemas)) checkRefs(`schemas/${name}.yaml`, s);

const { ajv, broken } = makeAjv(schemas);
for (const [name, msg] of Object.entries(broken)) fail(`schemas/${name}.yaml`, `invalid schema: ${msg}`);
for (const name of Object.keys(schemas)) {
  if (name in broken) continue;
  try {
    ajv.getSchema(`urn:osm:${name}`)?.call(null, null);
  } catch (e) {
    fail(`schemas/${name}.yaml`, String((e as Error).message).split("\n")[0]);
  }
}

if (withExamples) {
  let bad = 0;
  let total = 0;
  const groups = new Map<string, Any>();
  for (const f of files("calls")) {
    if (!f.split("/").pop()!.startsWith("_")) continue;
    const g = read(f);
    groups.set(`${g.method} ${g.path}`, g);
  }
  const strict = (s: Any): Any => ({ additionalProperties: false, ...s });
  const run = (file: string, what: string, schema: Any, value: Any) => {
    total++;
    const fn = compile(ajv, schema);
    if (fn && !fn(value)) {
      bad++;
      warnings.push(`${file}: ${what} does not validate: ${fn.errors?.[0]?.instancePath} ${fn.errors?.[0]?.message}${fn.errors?.[0]?.params?.additionalProperty ? ` \`${fn.errors[0].params.additionalProperty}\`` : ""}`);
    }
  };
  for (const { file, doc } of calls) {
    const group = groups.get(`${doc.method} ${doc.path}`);
    const r = doc.response ?? {};
    const examples = r.examples ?? group?.response_examples;
    if (examples && !r.document && !doc.removed) {
      const wrap = r.envelope ?? (doc.kind === "v3-route" ? kindsDoc.kinds["v3-route"].envelope !== false : false);
      const media = wrap ? envelopeOf(r.schema) : r.schema;
      if (media) for (const [key, ex] of Object.entries<Any>(examples)) run(file, `example "${key}"`, media, wrap ? wrapExample(key, ex.value) : ex.value);
    }
    if (doc.uses) continue;
    const body = doc.body;
    const bodySchema = body?.schema ?? (body ? bodyObject(body.params ?? {}) : undefined);
    const reqEx: [string, Any][] = [];
    if (body?.example !== undefined) reqEx.push(["body example", body.example]);
    else if (body && group?.request_examples) for (const [k, v] of Object.entries<Any>(group.request_examples)) reqEx.push([`request example "${k}"`, v]);
    for (const [what, v] of reqEx) {
      if (!bodySchema) continue;
      run(file, what, body?.schema ? bodySchema : strict(bodySchema), v);
    }
  }
  console.log(`examples: ${total - bad}/${total} validate`);
}

const unused = Object.keys(schemas).filter((n) => !refUse.has(n));
for (const n of unused) warnings.push(`schemas/${n}.yaml: not referenced`);

for (const w of warnings.slice(0, Number(process.env.WARN_MAX ?? 20))) console.warn("warn", w);
if (warnings.length > 20) console.warn(`warn ... ${warnings.length - 20} more`);
for (const e of errors.slice(0, 50)) console.error("error", e);
if (errors.length > 50) console.error(`error ... ${errors.length - 50} more`);
console.log(`${calls.length} calls, ${Object.keys(schemas).length} schemas, ${Object.keys(templates).length} templates: ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);
