import { describe, expect, test } from "bun:test";
import { inMinor, type Movement, productMethod, summarize } from "./rules";

const move = (
  receivedBy: string,
  method: Movement["method"],
  amountMinor: number,
): Movement => ({
  kind: "cut",
  source: "counter",
  method,
  amountMinor,
  receivedBy,
  customerId: "c",
  at: new Date("2026-10-22T18:00:00Z"),
  timeZone: "America/Tijuana",
});

describe("summarize", () => {
  test("adds up each method for the drawer and for each person", () => {
    const { totals, people } = summarize([
      move("ana", "cash", 25_000),
      move("ana", "card", 30_000),
      move("luis", "cash", 18_000),
      move("luis", "transfer", 10_000),
    ]);
    expect(inMinor(totals)).toEqual({
      cashMinor: 43_000,
      cardMinor: 30_000,
      transferMinor: 10_000,
    });
    expect(people.get("ana")).toEqual({
      cash: 25_000,
      card: 30_000,
      transfer: 0,
    });
    expect(people.get("luis")).toEqual({
      cash: 18_000,
      card: 0,
      transfer: 10_000,
    });
  });

  test("an empty day is all zeros", () => {
    expect(inMinor(summarize([]).totals)).toEqual({
      cashMinor: 0,
      cardMinor: 0,
      transferMinor: 0,
    });
  });
});

test("product pickups paid by SPEI count as transfers", () => {
  expect(productMethod("spei")).toBe("transfer");
  expect(productMethod("cash")).toBe("cash");
});
