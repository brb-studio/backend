import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  counterEntry,
  orderConcept,
  periodOf,
  periodsBetween,
  previousRange,
  tally,
} from "./rules";

describe("periods", () => {
  test("weeks start on Monday and months are YYYY-MM", () => {
    expect(periodOf("2026-11-04", "week")).toBe("2026-11-02");
    expect(periodOf("2026-11-02", "week")).toBe("2026-11-02");
    expect(periodOf("2026-11-01", "week")).toBe("2026-10-26");
    expect(periodOf("2026-11-04", "month")).toBe("2026-11");
    expect(periodsBetween("2026-10-30", "2026-11-02", "month")).toEqual([
      "2026-10",
      "2026-11",
    ]);
  });

  test("the previous range has the same length and ends the day before", () => {
    expect(previousRange("2026-11-01", "2026-11-30")).toEqual({
      from: "2026-10-02",
      to: "2026-10-31",
    });
    expect(previousRange("2026-11-04", "2026-11-04")).toEqual({
      from: "2026-11-03",
      to: "2026-11-03",
    });
  });
});

const row = (
  localDate: string,
  direction: "in" | "out",
  type: "service_payment" | "product_sale" | "payout",
  amountMinor: number,
) => ({ localDate, direction, type, method: "cash" as const, amountMinor });

describe("tally", () => {
  const rows = [
    row("2026-11-03", "in", "service_payment", 25_000),
    row("2026-11-03", "in", "product_sale", 18_000),
    row("2026-11-04", "out", "payout", 60_000),
    row("2026-11-05", "in", "service_payment", 30_000),
  ];

  test("adds money in and out, by type, method and period", () => {
    const t = tally(periodsBetween("2026-11-03", "2026-11-05", "day"), "day");
    for (const r of rows) t.push(r);
    expect(t.result()).toMatchObject({
      inMinor: 73_000,
      outMinor: 60_000,
      netMinor: 13_000,
      servicesMinor: 55_000,
      productsMinor: 18_000,
      byMethod: { cash: { inMinor: 73_000, outMinor: 60_000 } },
      series: [
        { period: "2026-11-03", inMinor: 43_000, outMinor: 0 },
        { period: "2026-11-04", inMinor: 0, outMinor: 60_000 },
        { period: "2026-11-05", inMinor: 30_000, outMinor: 0 },
      ],
    });
  });

  test("the days of a range add up to the range", () => {
    const range = tally([], "day");
    for (const r of rows) range.push(r);
    let inMinor = 0;
    let outMinor = 0;
    for (const day of periodsBetween("2026-11-03", "2026-11-05", "day")) {
      const one = tally([], "day");
      for (const r of rows.filter((r) => r.localDate === day)) one.push(r);
      inMinor += one.result().inMinor;
      outMinor += one.result().outMinor;
    }
    expect({ inMinor, outMinor }).toEqual({
      inMinor: range.result().inMinor,
      outMinor: range.result().outMinor,
    });
  });
});

test("an entry's day is the branch's local day, not UTC", () => {
  const entry = counterEntry(
    {
      _id: new ObjectId(),
      branchId: new ObjectId(),
      customerId: new ObjectId(),
      timeZone: "America/Tijuana",
      currency: "MXN",
      items: [
        {
          kind: "service",
          serviceId: new ObjectId(),
          name: { es: "Corte" },
          durationMin: 30,
          priceMinor: 25_000,
        },
      ],
    },
    {
      method: "cash",
      amountMinor: 25_000,
      receivedBy: new ObjectId(),
      at: new Date("2026-11-05T05:30:00Z"),
    },
  );
  expect(entry).toMatchObject({
    localDate: "2026-11-04",
    direction: "in",
    type: "service_payment",
    channel: "counter",
    concept: "Corte",
  });
});

test("product concepts list each item and its quantity", () => {
  expect(
    orderConcept([
      {
        productId: new ObjectId(),
        name: { es: "Cera" },
        priceMinor: 1,
        quantity: 2,
      },
      {
        productId: new ObjectId(),
        name: { en: "Comb" },
        priceMinor: 1,
        quantity: 1,
      },
    ]),
  ).toBe("Cera ×2 + Comb");
});
