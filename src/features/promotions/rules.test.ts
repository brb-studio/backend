import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { evaluate, type PromotionContext } from "./rules";

const centro = new ObjectId();
const corte = new ObjectId();
const premium = new ObjectId();
const now = new Date("2026-10-10T18:00:00Z");

const promo = (extra = {}) => ({
  _id: new ObjectId(),
  name: { es: "Promo" },
  type: "percent" as "percent" | "fixed",
  value: 10,
  branchIds: [] as ObjectId[],
  serviceIds: [] as ObjectId[],
  packageIds: [] as ObjectId[],
  firstVisitOnly: false,
  redemptions: 0,
  active: true,
  ...extra,
});
const ctx = (extra: Partial<PromotionContext> = {}): PromotionContext => ({
  now,
  branchId: centro,
  item: { kind: "service", id: corte },
  subtotalMinor: 70_000,
  customerVisits: 0,
  customerUses: 0,
  ...extra,
});

describe("evaluate", () => {
  test("percentage rounds down; fixed never goes below zero ($700 − $100 = $600)", () => {
    expect(
      evaluate(promo({ value: 15 }), ctx({ subtotalMinor: 33_333 })),
    ).toEqual({ ok: true, amountMinor: 4_999 });
    expect(evaluate(promo({ type: "fixed", value: 10_000 }), ctx())).toEqual({
      ok: true,
      amountMinor: 10_000,
    });
    expect(evaluate(promo({ type: "fixed", value: 99_999 }), ctx())).toEqual({
      ok: true,
      amountMinor: 70_000,
    });
  });

  test("restricts to services, packages and branches", () => {
    expect(evaluate(promo({ serviceIds: [corte] }), ctx()).ok).toBe(true);
    expect(evaluate(promo({ packageIds: [premium] }), ctx())).toEqual({
      ok: false,
      reason: "item",
    });
    expect(
      evaluate(
        promo({ packageIds: [premium] }),
        ctx({ item: { kind: "package", id: premium } }),
      ).ok,
    ).toBe(true);
    expect(evaluate(promo({ branchIds: [new ObjectId()] }), ctx())).toEqual({
      ok: false,
      reason: "branch",
    });
  });

  test("dates, minimum, first visit, per-customer and global limits", () => {
    expect(
      evaluate(promo({ startsAt: new Date("2026-10-11T00:00:00Z") }), ctx()),
    ).toEqual({ ok: false, reason: "not_started" });
    expect(evaluate(promo({ endsAt: now }), ctx())).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(evaluate(promo({ minSubtotalMinor: 80_000 }), ctx())).toEqual({
      ok: false,
      reason: "min_subtotal",
    });
    expect(
      evaluate(promo({ firstVisitOnly: true }), ctx({ customerVisits: 1 })),
    ).toEqual({ ok: false, reason: "first_visit" });
    expect(
      evaluate(promo({ maxPerCustomer: 1 }), ctx({ customerUses: 1 })),
    ).toEqual({ ok: false, reason: "customer_limit" });
    expect(
      evaluate(promo({ maxRedemptions: 5, redemptions: 5 }), ctx()),
    ).toEqual({ ok: false, reason: "exhausted" });
    expect(evaluate(promo({ active: false }), ctx())).toEqual({
      ok: false,
      reason: "inactive",
    });
  });
});
