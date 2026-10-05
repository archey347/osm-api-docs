import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYaml } from "./lib/yaml.ts";

type Any = any;
type Counts = { total: number; request: Record<string, number>; response: Record<string, number>; both: number };

const START = "<!-- coverage:start -->";
const END = "<!-- coverage:end -->";
const METHODS = ["get", "post", "put", "patch", "delete"];

export function countSources(spec: Any): Counts {
  const c: Counts = { total: 0, request: {}, response: {}, both: 0 };
  for (const item of Object.values<Any>(spec.paths ?? {})) {
    for (const m of METHODS) {
      const s = item[m]?.["x-source"];
      if (!s) continue;
      c.total++;
      c.request[s.request] = (c.request[s.request] ?? 0) + 1;
      c.response[s.response] = (c.response[s.response] ?? 0) + 1;
      if (s.request === "observed" && s.response === "observed") c.both++;
    }
  }
  return c;
}

const pct = (n: number, total: number) => `${n} (${total ? Math.round((n / total) * 100) : 0}%)`;

export function renderCoverage(c: Counts, version: string): string {
  const row = (label: string, r: Record<string, number>, unknown: boolean) =>
    `| ${label} | ${pct(r.observed ?? 0, c.total)} | ${pct(r.inferred ?? 0, c.total)} | ${unknown ? pct(r.unknown ?? 0, c.total) : "–"} |`;
  return [
    `Label coverage of the ${c.total} operations in ${version}:`,
    "",
    "| | Observed | Inferred | Unknown |",
    "|---|---|---|---|",
    row("Request", c.request, false),
    row("Response", c.response, true),
    "",
    `${pct(c.both, c.total)} are observed for both request and response. Unknown: the web app never reads the reply.`,
  ].join("\n");
}

export function spliceReadme(readme: string, block: string): string {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) throw new Error(`README.md needs ${START} and ${END} markers`);
  return readme.slice(0, a + START.length) + "\n" + block + "\n" + readme.slice(b);
}

if (import.meta.main) {
  const ROOT = resolve(import.meta.dir, "..");
  const spec = parseYaml(readFileSync(join(ROOT, "openapi.yaml"), "utf8"));
  const block = renderCoverage(countSources(spec), spec.info.version);
  const path = join(ROOT, "README.md");
  writeFileSync(path, spliceReadme(readFileSync(path, "utf8"), block));
  console.log(block);
}
