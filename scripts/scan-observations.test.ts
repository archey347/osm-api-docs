import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "scan-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const s = (t: string, extra: object = {}) => ({ t: [t], ...extra });
const envelope = (data: object) => s("object", { k: { status: s("boolean"), error: s("null"), data } });
const line = (shape: object, over: object = {}) => ({
  date: "2099-01-02",
  method: "GET",
  path: "/ext/dashboard/",
  action: "memberSearch",
  query_keys: ["sections", "v"],
  body_keys: [],
  status: 200,
  ok: true,
  shape,
  ...over,
});
const items = (item: object) => envelope(s("object", { k: { items: s("array", { i: item }) } }));
const member = s("object", { k: { scoutid: s("string"), sectionid: s("string"), firstname: s("string") } });

function scan(lines: object[]) {
  const file = join(dir, "shapes.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n\nnot json\n");
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "scan-observations.ts"), "--dry-run", "--json", file]);
  return { code: r.exitCode, out: JSON.parse(r.stdout.toString().trim().split("\n").pop()!) };
}

test("a shape-log line labels the call observed on the latest date", () => {
  const { code, out } = scan([line(items(member)), line(items(member), { date: "2099-01-01" })]);
  expect(code).toBe(0);
  expect(out.shapeLogs).toBe(1);
  expect(out.apiRequests).toBe(2);
  expect(out.labelChanges).toContainEqual({ file: "ext/dashboard/memberSearch.yaml", from: "inferred/inferred", to: "observed/observed" });
});

test("a type the schema forbids fails the strict check", () => {
  const { code, out } = scan([line(items(s("object", { k: { emails: s("string") } })))]);
  expect(code).toBe(1);
  expect(out.rejected.map((r: { id: string }) => r.id)).toEqual(["GET /ext/dashboard/?action=memberSearch"]);
});

test("a status:false line counts the request but not the response", () => {
  const { out } = scan([line(envelope(s("null")), { ok: false })]);
  expect(out.matched).toBe(1);
  expect(out.labelChanges[0].to).toBe("observed/inferred");
});

test("unknown calls and extra parameter names are reported without values", () => {
  const { out } = scan([line(items(member), { query_keys: ["sections", "v", "surprise"] }), line(s("object"), { path: "/ext/nope/{id}/", action: undefined })]);
  expect(out.unmatched).toEqual(["GET /ext/nope/{id}/"]);
  expect(out.labelChanges.every((c: { to: string }) => c.to !== "observed/observed")).toBe(true);
});
