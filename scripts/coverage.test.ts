import { describe, expect, test } from "bun:test";
import { countSources, renderCoverage, spliceReadme } from "./coverage.ts";

const op = (request: string, response: string) => ({ "x-source": { request, response } });

describe("coverage", () => {
  const spec = {
    paths: {
      "/a": { get: op("observed", "observed"), post: op("observed", "inferred") },
      "/b": { get: op("inferred", "unknown"), parameters: [] },
    },
  };

  test("counts labels per operation", () => {
    expect(countSources(spec)).toEqual({
      total: 3,
      request: { observed: 2, inferred: 1 },
      response: { observed: 1, inferred: 1, unknown: 1 },
      both: 1,
    });
  });

  test("replaces only the marked block", () => {
    const block = renderCoverage(countSources(spec), "1.2.3");
    const out = spliceReadme("top\n<!-- coverage:start -->\nold\n<!-- coverage:end -->\nbottom", block);
    expect(out).toBe(`top\n<!-- coverage:start -->\n${block}\n<!-- coverage:end -->\nbottom`);
    expect(block).toContain("| Request | 2 (67%) | 1 (33%) | – |");
  });

  test("refuses a README without markers", () => {
    expect(() => spliceReadme("no markers", "x")).toThrow();
  });
});
