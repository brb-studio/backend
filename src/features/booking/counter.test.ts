import { describe, expect, test } from "bun:test";
import type { AppointmentDoc } from "../../db/scoped";
import { dueAtCounter, paidBefore } from "./counter";

type Payment = NonNullable<AppointmentDoc["payment"]>;
const payment = (over: Partial<Payment>): Payment => ({
  provider: "stripe",
  status: "paid",
  amountMinor: 10_000,
  ...over,
});

describe("dueAtCounter", () => {
  test("without an online payment the whole total is due", () => {
    expect(dueAtCounter({ totalMinor: 35_000 })).toBe(35_000);
  });

  test("a paid deposit leaves the rest; a full payment leaves nothing", () => {
    expect(dueAtCounter({ totalMinor: 35_000, payment: payment({}) })).toBe(
      25_000,
    );
    expect(
      dueAtCounter({
        totalMinor: 35_000,
        payment: payment({ amountMinor: 35_000 }),
      }),
    ).toBe(0);
  });

  test("money not collected or given back is still due", () => {
    for (const status of ["pending", "expired"] as const) {
      expect(paidBefore(payment({ status }))).toBe(0);
    }
    expect(
      dueAtCounter({
        totalMinor: 35_000,
        payment: payment({ status: "refunded", refundedMinor: 10_000 }),
      }),
    ).toBe(35_000);
  });
});
