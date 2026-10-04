import { expect, test } from "bun:test";
import { hit } from "./rate-limit";

test("allows `limit` hits per window, per key, then resets", () => {
  const t = 1_000_000;
  for (let i = 0; i < 3; i++) expect(hit("a", 3, 60_000, t)).toBe(true);
  expect(hit("a", 3, 60_000, t + 1)).toBe(false);
  expect(hit("b", 3, 60_000, t + 1)).toBe(true);
  expect(hit("a", 3, 60_000, t + 60_000)).toBe(true);
});
