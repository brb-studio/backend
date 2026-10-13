import { describe, expect, test } from "bun:test";
import { inWindow } from "./rules";

describe("inWindow", () => {
  test("no window accepts any time", () => {
    expect(inWindow("09:00")).toBe(true);
  });

  test("bounds are inclusive and either side may be open", () => {
    expect(inWindow("14:00", "14:00", "16:00")).toBe(true);
    expect(inWindow("16:00", "14:00", "16:00")).toBe(true);
    expect(inWindow("16:15", "14:00", "16:00")).toBe(false);
    expect(inWindow("13:45", "14:00")).toBe(false);
    expect(inWindow("19:00", "14:00")).toBe(true);
    expect(inWindow("19:00", undefined, "18:00")).toBe(false);
  });
});
