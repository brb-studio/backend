import { describe, expect, test } from "bun:test";
import { addVisit, customerFilter, emptyTally, type Visit } from "./rules";

describe("customerFilter", () => {
  const base = { role: "customer" as const, deletedAt: { $exists: false } };

  test("no query lists every customer that still exists", () => {
    expect(customerFilter()).toEqual(base);
    expect(customerFilter("")).toEqual(base);
  });

  test("phone-looking queries search the stored digits", () => {
    expect(customerFilter("+52 (664) 12-3")).toEqual({
      ...base,
      phone: { $regex: "52664123" },
    });
  });

  test("text searches name and both emails, with regex characters escaped", () => {
    const pattern = { $regex: RegExp.escape("ana.p+"), $options: "i" };
    expect(customerFilter("ana.p+")).toEqual({
      ...base,
      $or: [{ name: pattern }, { email: pattern }, { contactEmail: pattern }],
    });
    expect(new RegExp(pattern.$regex, "i").test("Ana.P+")).toBe(true);
    expect(new RegExp(pattern.$regex, "i").test("anaxpp")).toBe(false);
  });
});

describe("addVisit", () => {
  const now = new Date("2026-10-22T18:00:00Z");
  const visit = (
    status: Visit["status"],
    startAt: string,
    totalMinor = 25_000,
  ): Visit => ({
    status,
    startAt: new Date(startAt),
    timeZone: "America/Tijuana",
    totalMinor,
  });

  test("counts completed cuts and misses, keeps the latest visit and the next booking", () => {
    const tally = emptyTally();
    for (const a of [
      visit("completed", "2026-09-01T17:00:00Z", 30_000),
      visit("completed", "2026-10-01T17:00:00Z", 25_000),
      visit("no_show", "2026-10-10T17:00:00Z"),
      visit("cancelled", "2026-10-12T17:00:00Z"),
      visit("confirmed", "2026-11-20T17:00:00Z"),
      visit("confirmed", "2026-10-30T17:00:00Z"),
      visit("pending_payment", "2026-10-25T17:00:00Z"),
    ]) {
      addVisit(tally, a, now);
    }
    expect(tally).toEqual({
      visits: 2,
      noShows: 1,
      spentMinor: 55_000,
      last: {
        at: new Date("2026-10-01T17:00:00Z"),
        timeZone: "America/Tijuana",
      },
      next: {
        at: new Date("2026-10-30T17:00:00Z"),
        timeZone: "America/Tijuana",
      },
    });
  });

  test("a confirmed visit that already started is not the next one", () => {
    const tally = emptyTally();
    addVisit(tally, visit("confirmed", "2026-10-22T17:30:00Z"), now);
    expect(tally.next).toBeUndefined();
  });
});
