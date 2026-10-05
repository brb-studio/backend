import type { Plan, TenantDoc } from "../../db/scoped";

/** The friend's discount on their first paid month, and the referrer's credit per friend who pays. */
export const REFERRAL = { friendPercent: 20, rewardPercent: 10 } as const;

/**
 * One subscription for everyone (300 MXN/month, the price lives in Stripe). Paying puts the tenant on
 * this plan and its limits.
 */
export const SUBSCRIPTION_PLAN = "pro" satisfies Plan;

/** 32 symbols without I, O, 0 and 1, so a code read aloud or from a screenshot can't be mistyped. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const REFERRAL_CODE = /^[A-HJ-NP-Z2-9]{8}$/;

/** 8 symbols × 5 bits = 40 random bits; 32 divides 256, so every symbol is equally likely. */
export const newReferralCode = (
  bytes = crypto.getRandomValues(new Uint8Array(8)),
) => Array.from(bytes, (byte) => ALPHABET[byte % 32]).join("");

/** What people type: lowercase, spaces, dashes (`7k3m-9qx2`). */
export const normalizeCode = (raw: string) =>
  raw.toUpperCase().replace(/[\s-]/g, "");

/** The referrer's credit: a share of what the friend's first month lists at, before the discount. */
export const rewardFor = (subtotalMinor: number) =>
  Math.round((subtotalMinor * REFERRAL.rewardPercent) / 100);

type Status = TenantDoc["subscription"]["status"];

/** Stripe subscription status → ours. `null`: not settled yet (first payment pending), change nothing. */
export function toStatus(stripe: string): Status | null {
  switch (stripe) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return null;
  }
}

/** A Stripe subscription that still bills: a new checkout would charge twice. */
export const hasLiveSubscription = (tenant: TenantDoc) =>
  Boolean(tenant.billing?.stripeSubscriptionId) &&
  tenant.subscription.status !== "canceled";
