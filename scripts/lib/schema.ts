import Ajv, { type ValidateFunction } from "ajv";

export const URN = "urn:osm:";

export function mapRefs<T>(node: T, f: (ref: string) => string): T {
  if (Array.isArray(node)) return node.map((n) => mapRefs(n, f)) as T;
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = k === "$ref" && typeof v === "string" ? f(v) : mapRefs(v, f);
    return out as T;
  }
  return node;
}

export function refsIn(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => refsIn(n, into));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") into.add(v);
      else refsIn(v, into);
    }
  }
  return into;
}

export function makeAjv(schemas: Record<string, unknown>): { ajv: Ajv; broken: Record<string, string> } {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const broken: Record<string, string> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    try {
      ajv.addSchema({ $id: URN + name, ...(mapRefs(schema, (r) => URN + r) as object) });
    } catch (e) {
      broken[name] = String((e as Error).message).split("\n")[0];
    }
  }
  return { ajv, broken };
}

const cache = new WeakMap<object, ValidateFunction | null>();

export function compile(ajv: Ajv, node: object): ValidateFunction | null {
  if (cache.has(node)) return cache.get(node)!;
  let fn: ValidateFunction | null = null;
  try {
    fn = ajv.compile(mapRefs(node, (r) => URN + r));
  } catch {
    fn = null;
  }
  cache.set(node, fn);
  return fn;
}

export function paramSchema(p: Record<string, any>, untyped: any = { type: "string" }): any {
  const { required: _r, description: _d, ...rest } = p;
  return Object.keys(rest).length ? rest : untyped;
}

export function bodyObject(params: Record<string, any>): any {
  const req = Object.entries(params).filter(([, p]) => p.required === true).map(([n]) => n);
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(params).map(([n, p]) => [n, { ...paramSchema(p, {}), ...(p.description ? { description: p.description } : {}) }])),
    ...(req.length ? { required: req } : {}),
    ...(Object.keys(params).some((n) => /[[{<]/.test(n)) ? { additionalProperties: true } : {}),
  };
}

export const isWholeBody = (key: string, v: any) =>
  v && typeof v === "object" && !Array.isArray(v) && ((typeof v.status === "boolean" && ("data" in v || "error" in v)) || v.status === false || /error|fail/i.test(key));

export const envelopeOf = (data: any | undefined): any => ({
  type: "object",
  properties: {
    status: { type: "boolean" },
    error: { type: "object", nullable: true, description: "`null` on success." },
    data: data ?? {},
    meta: { type: "object", nullable: true },
  },
});

export const wrapExample = (key: string, value: any): any => (isWholeBody(key, value) ? value : { status: true, error: null, data: value, meta: null });
