import { describe, expect, test } from "bun:test";
import { bumpVersion, diffSnapshots, levelOf, renderEntry, type Snapshot } from "./changelog.ts";

const call = (over: any = {}) => ({
  kind: "ext-action",
  method: "GET",
  path: "/ext/x/",
  action: "getX",
  summary: "Get X",
  source: { request: "inferred", response: "inferred" },
  query: { sectionid: { type: "string" } },
  response: { schema: { type: "object", properties: { id: { type: "string" } } } },
  ...over,
});
const snap = (calls: any[], schemas: Record<string, any> = {}): Snapshot => ({ kinds: {}, schemas, templates: {}, calls, groups: [] });
const level = (a: Snapshot, b: Snapshot) => levelOf(diffSnapshots(a, b));
const A = snap([call()]);

describe("classifier", () => {
  test("no changes", () => {
    expect(diffSnapshots(A, snap([call()]))).toEqual([]);
    expect(level(A, snap([call()]))).toBeNull();
  });
  test("breaking: removed call, removed/required/renamed param, removed field, type change", () => {
    expect(level(A, snap([]))).toBe("breaking");
    expect(level(A, snap([call({ query: {} })]))).toBe("breaking");
    expect(level(A, snap([call({ query: { sectionid: { type: "string" }, t: { type: "string", required: true } } })]))).toBe("breaking");
    const r = diffSnapshots(A, snap([call({ query: { section: { type: "string" } } })]));
    expect(r.some((c) => c.note.includes("renamed"))).toBe(true);
    expect(level(A, snap([call({ response: { schema: { type: "object", properties: {} } } })]))).toBe("breaking");
    expect(level(A, snap([call({ response: { schema: { type: "object", properties: { id: { type: "integer" } } } } })]))).toBe("breaking");
    expect(level(A, snap([call({ removed: { http: 410 } })]))).toBe("breaking");
  });
  test("additive: new call, optional param, field, enum value, deprecated", () => {
    expect(level(A, snap([call(), call({ action: "getY" })]))).toBe("additive");
    expect(level(A, snap([call({ query: { sectionid: { type: "string" }, t: { type: "string" } } })]))).toBe("additive");
    expect(level(A, snap([call({ response: { schema: { type: "object", properties: { id: { type: "string" }, n: { type: "string" } } } } })]))).toBe("additive");
    const e = (v: string[]) => snap([call({ query: { m: { type: "string", enum: v } } })]);
    expect(level(e(["a"]), e(["a", "b"]))).toBe("additive");
    const d = diffSnapshots(A, snap([call({ deprecated: "gone" })]));
    expect(d[0].section).toBe("Deprecated");
    expect(levelOf(d)).toBe("additive");
  });
  test("other: text and source labels", () => {
    expect(level(A, snap([call({ summary: "Changed" })]))).toBe("other");
    const up = diffSnapshots(A, snap([call({ source: { request: "observed", response: "inferred", observed_on: "2026-01-01" } })]));
    expect(levelOf(up)).toBe("other");
    expect(up[0]).toMatchObject({ section: "Newly observed", note: "request on 2026-01-01" });
  });
  test("schema $ref change attributes to every caller", () => {
    const c = (n: string) => call({ action: n, response: { schema: { $ref: "S" } } });
    const s = (props: any) => ({ S: { type: "object", properties: props } });
    const d = diffSnapshots(snap([c("a"), c("b")], s({ id: {} })), snap([c("a"), c("b")], s({})));
    expect(d.map((x) => x.id).sort()).toEqual(["GET /ext/x/ a", "GET /ext/x/ b"]);
    expect(levelOf(d)).toBe("breaking");
  });
  test("recursive schemas terminate", () => {
    const s = { T: { type: "object", properties: { kids: { type: "array", items: { $ref: "T" } } } } };
    const c = call({ response: { schema: { $ref: "T" } } });
    expect(diffSnapshots(snap([c], s), snap([c], s))).toEqual([]);
  });
});

describe("bump", () => {
  test("post-1.0", () => {
    expect(bumpVersion("1.2.3", "breaking")).toBe("2.0.0");
    expect(bumpVersion("1.2.3", "additive")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "other")).toBe("1.2.4");
  });
  test("pre-1.0", () => {
    expect(bumpVersion("0.3.4", "breaking")).toBe("0.4.0");
    expect(bumpVersion("0.3.4", "additive")).toBe("0.3.5");
    expect(bumpVersion("0.3.4", "other")).toBe("0.3.5");
  });
});

describe("render", () => {
  test("sections and collapse", () => {
    const calls = Array.from({ length: 400 }, (_, i) => call({ action: `a${i}`, path: `/ext/m${i % 20}/` }));
    const out = renderEntry("1.0.0", "2026-01-01", diffSnapshots(snap([]), snap(calls)));
    expect(out.startsWith("## 1.0.0 - 2026-01-01")).toBe(true);
    expect(out).toContain("### Added");
    expect(out.split("\n").length).toBeLessThanOrEqual(150);
  });
});
