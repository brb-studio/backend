import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { TenantDoc } from "../../db/scoped";
import {
  isPaidUp,
  newReferralCode,
  normalizeCode,
  periodEnd,
  REFERRAL_CODE,
  rewardFor,
} from "./rules";

describe("referral codes", () => {
  test("8 unambiguous symbols", () => {
    for (let i = 0; i < 200; i++)
      expect(newReferralCode()).toMatch(REFERRAL_CODE);
    expect(
      newReferralCode(new Uint8Array([0, 31, 32, 255, 8, 14, 24, 25])),
    ).toBe("A9A9JQ23");
  });

  test("what people type is normalized", () => {
    expect(normalizeCode(" abcd-efgh ")).toBe("ABCDEFGH");
    expect(normalizeCode("ab cd ef gh")).toBe("ABCDEFGH");
  });
});

describe("rewardFor", () => {
  test("10% of the friend's list price, in whole minor units", () => {
    expect(rewardFor(30_000)).toBe(3_000);
    expect(rewardFor(29_999)).toBe(3_000);
    expect(rewardFor(0)).toBe(0);
  });
});

describe("periodEnd", () => {
  const now = new Date("2026-01-31T12:00:00Z");

  test("adds one calendar month, clamped to the month's last day", () => {
    expect(periodEnd(undefined, now).toISOString()).toBe(
      "2026-02-28T12:00:00.000Z",
    );
  });

  test("paying early extends what is left instead of wasting it", () => {
    const left = new Date("2026-03-10T00:00:00Z");
    expect(periodEnd(left, now).toISOString()).toBe("2026-04-10T00:00:00.000Z");
    const over = new Date("2026-01-01T00:00:00Z");
    expect(periodEnd(over, now).toISOString()).toBe("2026-02-28T12:00:00.000Z");
  });
});

test("isPaidUp", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const tenant = (
    plan: TenantDoc["subscription"]["plan"],
    status: TenantDoc["subscription"]["status"],
    end?: string,
  ) =>
    ({
      _id: new ObjectId(),
      subscription: {
        plan,
        status,
        limits: { branches: 1, barbers: 5 },
        ...(end && { currentPeriodEnd: new Date(end) }),
      },
    }) as TenantDoc;
  expect(isPaidUp(tenant("pro", "active", "2026-03-01"), now)).toBe(true);
  expect(isPaidUp(tenant("pro", "active", "2026-01-15"), now)).toBe(false);
  expect(isPaidUp(tenant("pro", "canceled", "2026-03-01"), now)).toBe(false);
  expect(isPaidUp(tenant("trial", "trialing", "2026-03-01"), now)).toBe(false);
  expect(isPaidUp(tenant("pro", "active"), now)).toBe(false);
});
