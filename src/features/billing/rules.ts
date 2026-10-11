import type { Plan, TenantDoc } from "../../db/scoped";

/** The friend's discount on their first paid month, and the referrer's credit per friend who pays. */
export const REFERRAL = { friendPercent: 20, rewardPercent: 10 } as const;

/**
 * One subscription for everyone (SUBSCRIPTION_PRICE_MINOR a month, paid by SPEI transfer). Paying puts the
 * tenant on this plan and its limits.
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

/** Months paid are added to whatever is left of the current period, so paying early never wastes days. */
export function periodEnd(current: Date | undefined, now: Date) {
  const start = current && current > now ? current : now;
  const end = Temporal.Instant.fromEpochMilliseconds(start.getTime())
    .toZonedDateTimeISO("UTC")
    .add({ months: 1 });
  return new Date(end.epochMilliseconds);
}

/** Paid up: a plan that is not the trial, with a period that has not ended. */
export const isPaidUp = (tenant: TenantDoc, now: Date) => {
  const end = tenant.subscription.currentPeriodEnd;
  return (
    tenant.subscription.plan !== "trial" &&
    tenant.subscription.status !== "canceled" &&
    Boolean(end && end > now)
  );
};
