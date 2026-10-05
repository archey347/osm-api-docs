// Structure-only view of a JSON value (FORMAT.md, "Shape logs").
export interface Shape {
  t: string[];
  k?: Record<string, Shape>;
  i?: Shape;
}

export const looksData = (k: string) =>
  /^\d+$/.test(k) || /^\d{4}-\d{2}-\d{2}/.test(k) || /[@ ]/.test(k) || /\d{3,}/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k) || /^[0-9a-f]{12,}$/i.test(k);

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);

export function mergeShape(a: Shape | undefined, b: Shape): Shape {
  if (!a) return b;
  const out: Shape = { t: [...new Set([...a.t, ...b.t])].sort() };
  if (a.k || b.k) {
    out.k = { ...a.k };
    for (const [name, s] of Object.entries(b.k ?? {})) out.k[name] = mergeShape(out.k[name], s);
  }
  if (a.i || b.i) out.i = b.i ? mergeShape(a.i, b.i) : a.i!;
  return out;
}

export function shapeOf(v: unknown): Shape {
  const s: Shape = { t: [typeOf(v)] };
  if (Array.isArray(v)) {
    for (const x of v) s.i = mergeShape(s.i, shapeOf(x));
  } else if (v && typeof v === "object") {
    const keys = Object.keys(v);
    const collapse = keys.filter(looksData).length * 2 > keys.length;
    s.k = {};
    for (const key of keys) {
      const name = collapse || looksData(key) ? "{key}" : key;
      s.k[name] = mergeShape(s.k[name], shapeOf((v as Record<string, unknown>)[key]));
    }
  }
  return s;
}

/** Shapes come from files we don't control, so check the structure before trusting it. */
export function isShape(x: any, depth = 0): x is Shape {
  if (!x || typeof x !== "object" || depth > 40 || !Array.isArray(x.t) || !x.t.every((t: unknown) => typeof t === "string")) return false;
  if (x.k !== undefined && (typeof x.k !== "object" || x.k === null || !Object.values(x.k).every((v) => isShape(v, depth + 1)))) return false;
  return x.i === undefined || isShape(x.i, depth + 1);
}

/** One example value per union member in turn, enough to run a validator over every type a path was seen with. */
export function sampleValues(shape: Shape): unknown[] {
  const width = (s: Shape): number => Math.max(s.t.length, ...Object.values(s.k ?? {}).map(width), s.i ? width(s.i) : 1);
  const build = (s: Shape, n: number): unknown => {
    const t = s.t[n % s.t.length];
    if (t === "object") return Object.fromEntries(Object.entries(s.k ?? {}).map(([k, v]) => [k === "{key}" ? "x" : k, build(v, n)]));
    if (t === "array") return s.i ? [build(s.i, n)] : [];
    return t === "string" ? "x" : t === "integer" ? 1 : t === "number" ? 0.5 : t === "boolean" ? true : null;
  };
  return Array.from({ length: width(shape) }, (_, n) => build(shape, n));
}
