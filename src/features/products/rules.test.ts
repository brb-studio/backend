import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { expiryFrom, MAX_QUANTITY, mergeLines, totalOf } from "./rules";
import { orderCode, orderIdOf } from "./token";

describe("reservation lines", () => {
  test("the same product twice is one line, capped", () => {
    const lines = mergeLines([
      { product: "cera", quantity: 2 },
      { product: "aceite", quantity: 1 },
      { product: "cera", quantity: 3 },
    ]);
    expect(lines.get("cera")).toBe(5);
    expect(lines.get("aceite")).toBe(1);
    expect(
      mergeLines([
        { product: "cera", quantity: MAX_QUANTITY },
        { product: "cera", quantity: MAX_QUANTITY },
      ]).get("cera"),
    ).toBe(MAX_QUANTITY);
  });

  test("totals are whole minor units and the reservation lasts a week", () => {
    expect(
      totalOf([
        { priceMinor: 18_000, quantity: 2 },
        { priceMinor: 9_950, quantity: 1 },
      ]),
    ).toBe(45_950);
    const now = new Date("2030-01-01T00:00:00Z");
    expect(expiryFrom(now).toISOString()).toBe("2030-01-08T00:00:00.000Z");
  });
});

describe("order code", () => {
  test("round-trips, and a forged or edited code is refused", () => {
    const id = new ObjectId();
    const code = orderCode(id);
    expect(orderIdOf(code)?.equals(id)).toBe(true);
    expect(orderIdOf(` ${code}\n`)?.equals(id)).toBe(true);
    expect(orderIdOf(id.toHexString())).toBeUndefined();
    expect(
      orderIdOf(`${id.toHexString()}.AAAAAAAAAAAAAAAAAAAAAA`),
    ).toBeUndefined();
    expect(
      orderIdOf(`${new ObjectId().toHexString()}.${code.split(".")[1]}`),
    ).toBeUndefined();
    expect(orderIdOf(`${code}.x`)).toBeUndefined();
    expect(orderIdOf("")).toBeUndefined();
  });
});
