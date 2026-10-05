import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { TenantDoc } from "../../db/scoped";
import {
  hasLiveSubscription,
  newReferralCode,
  normalizeCode,
  REFERRAL_CODE,
  rewardFor,
  toStatus,
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

describe("toStatus", () => {
  test("maps Stripe statuses; a pending first payment changes nothing", () => {
    expect(toStatus("active")).toBe("active");
    expect(toStatus("trialing")).toBe("trialing");
    expect(toStatus("past_due")).toBe("past_due");
    expect(toStatus("unpaid")).toBe("past_due");
    expect(toStatus("canceled")).toBe("canceled");
    expect(toStatus("incomplete_expired")).toBe("canceled");
    expect(toStatus("incomplete")).toBeNull();
  });
});

test("hasLiveSubscription", () => {
  const tenant = (status: TenantDoc["subscription"]["status"], sub?: string) =>
    ({
      _id: new ObjectId(),
      subscription: {
        plan: "basic",
        status,
        limits: { branches: 1, barbers: 5 },
      },
      ...(sub && { billing: { stripeSubscriptionId: sub } }),
    }) as TenantDoc;
  expect(hasLiveSubscription(tenant("active", "sub_1"))).toBe(true);
  expect(hasLiveSubscription(tenant("past_due", "sub_1"))).toBe(true);
  expect(hasLiveSubscription(tenant("canceled", "sub_1"))).toBe(false);
  expect(hasLiveSubscription(tenant("trialing"))).toBe(false);
});
