import { describe, expect, test } from "bun:test";
import { ivaFor, ivaIncluded } from "./rules";

describe("IVA inside a price", () => {
  test("splits a total into base and tax that add up to it", () => {
    expect(ivaIncluded(11_600)).toEqual({ baseMinor: 10_000, ivaMinor: 1_600 });
    const { baseMinor, ivaMinor } = ivaIncluded(30_000);
    expect(baseMinor + ivaMinor).toBe(30_000);
    expect(ivaMinor).toBe(4_138);
  });

  test("shows nothing unless the shop turned IVA on", () => {
    expect(ivaFor(false, 11_600)).toEqual({});
    expect(ivaFor(undefined, 11_600)).toEqual({});
    expect(ivaFor(true, 11_600)).toEqual({
      iva: { baseMinor: 10_000, ivaMinor: 1_600 },
    });
  });
});
