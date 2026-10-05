export type Part = "request" | "response";
export type Source = {
  request: "observed" | "inferred";
  response: "observed" | "inferred" | "unknown";
  observed_on?: string | { request?: string; response?: string };
};

export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Date of each observed part; "unknown" marks an observation whose date could not be recovered. */
export function observedDates(s: Source): Partial<Record<Part, string>> {
  const o = s.observed_on;
  const out: Partial<Record<Part, string>> = {};
  for (const p of ["request", "response"] as const) {
    if (s[p] !== "observed") continue;
    const d = typeof o === "string" ? o : o?.[p];
    if (d) out[p] = d;
  }
  return out;
}

export function makeSource(request: Source["request"], response: Source["response"], dates: Partial<Record<Part, string>> = {}): Source {
  const src: Source = { request, response };
  const vals = Object.values(dates);
  if (!vals.length) return src;
  const parts = (["request", "response"] as const).filter((p) => src[p] === "observed");
  src.observed_on = vals.length === parts.length && new Set(vals).size === 1 ? vals[0] : { ...dates };
  return src;
}

export function renderSource(s: Source): string[] {
  const lines = ["source:", `  request: ${s.request}`, `  response: ${s.response}`];
  if (typeof s.observed_on === "string") lines.push(`  observed_on: ${s.observed_on}`);
  else if (s.observed_on) {
    lines.push("  observed_on:");
    for (const [k, v] of Object.entries(s.observed_on)) lines.push(`    ${k}: ${v}`);
  }
  return lines;
}

/** Replaces the file's `source:` block (or the old `verified:` line), else inserts one after `tags:`; other lines stay untouched. */
export function setSource(text: string, s: Source): string {
  const lines = text.split("\n");
  const block = renderSource(s);
  const at = lines.findIndex((l) => l === "source:" || l.startsWith("source: "));
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && /^\s/.test(lines[end])) end++;
    lines.splice(at, end - at, ...block);
    return lines.join("\n");
  }
  const v = lines.findIndex((l) => l === "verified: false" || l === "verified: true");
  if (v >= 0) {
    lines.splice(v, 1, ...block);
    return lines.join("\n");
  }
  let i = lines.findIndex((l) => l.startsWith("tags:"));
  if (i < 0) i = lines.findIndex((l) => l.startsWith("summary:"));
  lines.splice(i + 1, 0, ...block);
  return lines.join("\n");
}
