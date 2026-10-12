import { describe, expect, test } from "bun:test";
import {
  amountFor,
  applicationFee,
  cardFeeRate,
  connectStatus,
  customerRefundable,
  debtAfterRefund,
  debtToCollect,
  depositFor,
  holdEnds,
  isOnlineCurrency,
  kindOf,
  methodsFor,
  onlineOffer,
  refundOnCancel,
  STRIPE_MIN_CHARGE,
  STRIPE_MIN_MXN,
  transferFits,
} from "./rules";

describe("depositFor", () => {
  test("rounds up to the whole peso", () => {
    expect(depositFor(25_000, 2_500)).toBe(6_300);
    expect(depositFor(30_000, 2_500)).toBe(7_500);
    expect(depositFor(25_050, 1_000)).toBe(2_600);
  });

  test("is raised to Stripe's minimum and capped at the total", () => {
    expect(depositFor(2_000, 1_000)).toBe(STRIPE_MIN_MXN);
    expect(depositFor(25_000, 10_000)).toBe(25_000);
    expect(depositFor(1_200, 9_000)).toBe(1_100);
    expect(depositFor(1_200, 9_900)).toBe(1_200);
  });
});

describe("onlineOffer", () => {
  test("nothing online under Stripe's minimum", () => {
    expect(onlineOffer(999, { enabled: true, percentBps: 5_000 })).toBe(
      undefined,
    );
  });

  test("without a deposit only the full amount, and paying is optional", () => {
    expect(onlineOffer(25_000, undefined)).toEqual({
      required: false,
      fullMinor: 25_000,
    });
    expect(onlineOffer(25_000, { enabled: false, percentBps: 2_500 })).toEqual({
      required: false,
      fullMinor: 25_000,
    });
  });

  test("with a deposit both amounts, and paying is required", () => {
    const offer = onlineOffer(25_000, { enabled: true, percentBps: 2_500 });
    expect(offer).toEqual({
      required: true,
      fullMinor: 25_000,
      depositMinor: 6_300,
    });
    if (!offer) throw new Error("expected an offer");
    expect(amountFor(offer, "deposit")).toBe(6_300);
    expect(amountFor(offer, "full")).toBe(25_000);
  });

  test("a deposit as large as the total is just the full payment", () => {
    const offer = onlineOffer(1_100, { enabled: true, percentBps: 9_500 });
    expect(offer).toEqual({ required: true, fullMinor: 1_100 });
    if (!offer) throw new Error("expected an offer");
    expect(amountFor(offer, "deposit")).toBe(1_100);
    expect(kindOf(offer, "deposit")).toBe("full");
  });
});

describe("applicationFee", () => {
  test("percent plus fixed plus tax, rounded up", () => {
    // 3.6% of 250.00 = 9.00, + 3.00 = 12.00, + 16% = 13.92
    expect(applicationFee(25_000, { bps: 360, fixedMinor: 300 }, 1_600)).toBe(
      1_392,
    );
    // 7.00 + 16% = 8.12
    expect(applicationFee(6_300, { bps: 0, fixedMinor: 700 }, 1_600)).toBe(812);
    expect(applicationFee(6_301, { bps: 1, fixedMinor: 0 }, 0)).toBe(1);
  });

  test("never more than the amount", () => {
    expect(applicationFee(1_000, { bps: 0, fixedMinor: 5_000 }, 0)).toBe(1_000);
  });
});

describe("holds", () => {
  const minutes = { card: 20, bank_transfer: 60 };
  const now = Date.parse("2026-10-11T15:00:00Z");

  test("cards hold the slot less time than transfers", () => {
    expect(holdEnds("card", now, minutes).toISOString()).toBe(
      "2026-10-11T15:20:00.000Z",
    );
    expect(holdEnds("bank_transfer", now, minutes).toISOString()).toBe(
      "2026-10-11T16:00:00.000Z",
    );
  });

  test("a transfer only fits when its hold ends before the visit", () => {
    const deadline = holdEnds("bank_transfer", now, minutes);
    expect(transferFits(new Date("2026-10-11T16:00:00Z"), deadline)).toBe(true);
    expect(transferFits(new Date("2026-10-11T15:59:00Z"), deadline)).toBe(
      false,
    );
  });
});

describe("refundOnCancel", () => {
  const startAt = new Date("2026-10-12T15:00:00Z");
  const base = {
    leftMinor: 6_300,
    stripeFeeMinor: 662,
    startAt,
    cancelNoticeMin: 120,
  };

  test("the barbershop cancelling returns everything, fee included", () => {
    expect(
      refundOnCancel({ ...base, by: "staff", now: startAt.getTime() }),
    ).toBe(6_300);
  });

  test("the customer cancelling in time gets it back minus Stripe's fee; late, it is kept", () => {
    const deadline = startAt.getTime() - 120 * 60_000;
    expect(refundOnCancel({ ...base, by: "customer", now: deadline })).toBe(
      5_638,
    );
    expect(refundOnCancel({ ...base, by: "customer", now: deadline + 1 })).toBe(
      0,
    );
  });

  test("nothing left, nothing returned; the fee never makes it negative", () => {
    expect(refundOnCancel({ ...base, leftMinor: 0, by: "staff", now: 0 })).toBe(
      0,
    );
    expect(customerRefundable(500, 662)).toBe(0);
  });
});

describe("fee debt", () => {
  test("collected on the next charge, never leaving the shop with nothing", () => {
    expect(debtToCollect(1_392, 25_000, 1_392)).toBe(1_392);
    expect(debtToCollect(5_000, 6_300, 2_000)).toBe(4_300);
    expect(debtToCollect(0, 6_300, 662)).toBe(0);
  });

  test("the shop owes the shortfall when it cancelled; otherwise only the old debt comes back", () => {
    // Full refund of 250.00: the shop had received 236.08, the platform covers 13.92.
    const refund = { refundMinor: 25_000, reversedMinor: 23_608 };
    expect(
      debtAfterRefund({ ...refund, debtCollectedMinor: 0, shopPays: true }),
    ).toBe(1_392);
    expect(
      debtAfterRefund({ ...refund, debtCollectedMinor: 0, shopPays: false }),
    ).toBe(0);
    expect(
      debtAfterRefund({ ...refund, debtCollectedMinor: 500, shopPays: false }),
    ).toBe(500);
    expect(
      debtAfterRefund({
        refundMinor: 10_000,
        reversedMinor: 10_000,
        debtCollectedMinor: 0,
        shopPays: true,
      }),
    ).toBe(0);
  });
});

describe("connectStatus", () => {
  test("active as soon as Stripe can transfer", () => {
    expect(connectStatus("active", true, "onboarding")).toBe("active");
  });

  test("under review when nothing is waiting for the owner", () => {
    expect(connectStatus("pending", false, "onboarding")).toBe("pending");
  });

  test("still onboarding until the form is done; afterwards, restricted", () => {
    expect(connectStatus(undefined, true, undefined)).toBe("onboarding");
    expect(connectStatus("restricted", true, "onboarding")).toBe("onboarding");
    expect(connectStatus("pending", true, "onboarding")).toBe("onboarding");
    expect(connectStatus("restricted", true, "active")).toBe("restricted");
    expect(connectStatus("unsupported", false, "pending")).toBe("restricted");
  });
});

describe("dollars", () => {
  const fees = {
    bps: 360,
    internationalBps: 50,
    conversionBps: 200,
    fixedMinor: { MXN: 300, USD: 20 },
  };

  test("pesos estimate a domestic card; dollars a foreign card plus conversion", () => {
    expect(cardFeeRate("MXN", fees)).toEqual({ bps: 360, fixedMinor: 300 });
    expect(cardFeeRate("USD", fees)).toEqual({ bps: 610, fixedMinor: 20 });
    // 6.1% of 25.00 = 1.525, + 0.20 = 1.725, + 16% IVA = 2.001 → 2.01
    expect(applicationFee(2_500, cardFeeRate("USD", fees), 1_600)).toBe(201);
  });

  test("a dollar deposit rounds up to the whole dollar and respects USD 0.50", () => {
    expect(
      onlineOffer(2_500, { enabled: true, percentBps: 2_500 }, "USD"),
    ).toEqual({ required: true, fullMinor: 2_500, depositMinor: 700 });
    expect(onlineOffer(49, undefined, "USD")).toBeUndefined();
    expect(onlineOffer(60, undefined, "USD")).toEqual({
      required: false,
      fullMinor: 60,
    });
    expect(depositFor(1_000, 100, STRIPE_MIN_CHARGE.USD)).toBe(100);
  });

  test("dollars take cards only; Mexican transfers are pesos only", () => {
    expect(methodsFor("USD")).toEqual(["card"]);
    expect(methodsFor("MXN")).toEqual(["card", "bank_transfer"]);
    expect(isOnlineCurrency("USD")).toBe(true);
    expect(isOnlineCurrency("EUR")).toBe(false);
  });
});
