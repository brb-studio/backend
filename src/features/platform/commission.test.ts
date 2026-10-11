import { describe, expect, test } from "bun:test";
import { commissionOf, resolveCommission } from "./commission";

describe("commission", () => {
  test("rounds half up in minor units", () => {
    expect(commissionOf(30_000, 4_000)).toBe(12_000);
    expect(commissionOf(1_050, 1_000)).toBe(105);
    expect(commissionOf(1_005, 1_000)).toBe(101); // 100.5 → 101
    expect(commissionOf(999, 0)).toBe(0);
    expect(commissionOf(999, 10_000)).toBe(999);
  });

  test("only completed appointments earn, and a rate is never invented", () => {
    const base = { totalMinor: 20_000 };
    expect(
      resolveCommission({ ...base, status: "confirmed" }, 5_000),
    ).toBeNull();
    expect(
      resolveCommission({ ...base, status: "cancelled" }, 5_000),
    ).toBeNull();
    expect(
      resolveCommission({ ...base, status: "completed" }, undefined),
    ).toBeNull();
    expect(resolveCommission({ ...base, status: "completed" }, 5_000)).toEqual({
      bps: 5_000,
      amountMinor: 10_000,
      source: "barber_config",
    });
  });

  test("a frozen snapshot beats the current rate", () => {
    expect(
      resolveCommission(
        {
          status: "completed",
          totalMinor: 20_000,
          commission: { bps: 3_000, amountMinor: 6_000 },
        },
        9_000,
      ),
    ).toEqual({ bps: 3_000, amountMinor: 6_000, source: "snapshot" });
  });
});
