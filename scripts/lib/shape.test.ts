import { expect, test } from "bun:test";
import cases from "../fixtures/shape-cases.json";
import { isShape, sampleValues, shapeOf } from "./shape.ts";

for (const c of cases) test(c.name, () => expect(shapeOf(c.input)).toEqual(c.shape as never));

test("isShape rejects malformed input", () => {
  expect(isShape({ t: ["object"], k: { a: { t: ["string"] } } })).toBe(true);
  for (const bad of [null, {}, { t: "string" }, { t: [1] }, { t: ["object"], k: { a: {} } }, { t: ["array"], i: 3 }]) expect(isShape(bad)).toBe(false);
});

test("sampleValues covers each union member", () => {
  const samples = sampleValues({ t: ["array"], i: { t: ["object"], k: { a: { t: ["integer", "null"] } } } });
  expect(samples).toEqual([[{ a: 1 }], [{ a: null }]]);
});
