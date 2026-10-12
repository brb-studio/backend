import type { PaymentKind, PaymentMethod, TenantDoc } from "../../db/scoped";

type ConnectStatus = NonNullable<TenantDoc["stripeConnect"]>["status"];

/**
 * A connected account's state from Stripe's transfers capability (`active`, `pending`, `restricted`,
 * `unsupported`) and whether the owner still has to give Stripe something. Until it is first active or
 * under review, an account the owner hasn't completed is still `onboarding`.
 */
export function connectStatus(
  transfers: string | undefined,
  ownerMustAct: boolean,
  previous: ConnectStatus | undefined,
): ConnectStatus {
  if (transfers === "active") return "active";
  if (transfers === "pending" && !ownerMustAct) return "pending";
  if (!previous || previous === "onboarding") return "onboarding";
  return "restricted";
}

/** Currencies a barbershop can charge online in: Stripe Mexico settles both, in pesos. */
export const ONLINE_CURRENCIES = ["MXN", "USD"] as const;
export type OnlineCurrency = (typeof ONLINE_CURRENCIES)[number];

export const isOnlineCurrency = (
  currency: string,
): currency is OnlineCurrency => ONLINE_CURRENCIES.some((c) => c === currency);

/** Stripe's minimum charge in MXN (10.00), for cards and Mexican bank transfers alike. */
export const STRIPE_MIN_MXN = 1_000;

/** Stripe's minimum charge per currency, in minor units: MXN 10.00, USD 0.50. */
export const STRIPE_MIN_CHARGE: Record<OnlineCurrency, number> = {
  MXN: STRIPE_MIN_MXN,
  USD: 50,
};

/** Mexican bank transfers (SPEI) only take pesos: a shop charging in dollars takes cards only. */
export const methodsFor = (
  currency: OnlineCurrency,
): Exclude<PaymentMethod, "spei">[] =>
  currency === "MXN" ? ["card", "bank_transfer"] : ["card"];

export type DepositSettings = { enabled: boolean; percentBps: number };

/**
 * The deposit for a total: `percentBps` of it rounded **up to a whole unit** (peso or dollar), raised
 * to Stripe's minimum for the currency, and never more than the total. 25% of 250.00 → 62.50 → 63.00.
 * Both currencies have two decimals, so a whole unit is 100 minor units.
 */
export function depositFor(
  totalMinor: number,
  percentBps: number,
  minMinor = STRIPE_MIN_MXN,
) {
  const wholePesos = Math.ceil((totalMinor * percentBps) / 1_000_000) * 100;
  return Math.min(totalMinor, Math.max(minMinor, wholePesos));
}

export type OnlineOffer = {
  /** True when the barbershop requires paying at least the deposit to book online. */
  required: boolean;
  fullMinor: number;
  /** Absent when the barbershop takes no deposit or the deposit would be the whole total. */
  depositMinor?: number;
};

/**
 * What a customer may pay online for a visit, or `undefined` when nothing can be charged online (a
 * total under Stripe's minimum books as before, without paying).
 */
export function onlineOffer(
  totalMinor: number,
  deposit: DepositSettings | undefined,
  currency: OnlineCurrency = "MXN",
): OnlineOffer | undefined {
  const minMinor = STRIPE_MIN_CHARGE[currency];
  if (totalMinor < minMinor) return undefined;
  const required = deposit?.enabled === true;
  const depositMinor =
    required && deposit
      ? depositFor(totalMinor, deposit.percentBps, minMinor)
      : undefined;
  return {
    required,
    fullMinor: totalMinor,
    ...(depositMinor !== undefined &&
      depositMinor < totalMinor && { depositMinor }),
  };
}

/** The amount for the kind the customer chose; a deposit the shop doesn't take charges the full total. */
export const amountFor = (offer: OnlineOffer, kind: PaymentKind) =>
  kind === "deposit"
    ? (offer.depositMinor ?? offer.fullMinor)
    : offer.fullMinor;

export const kindOf = (offer: OnlineOffer, kind: PaymentKind): PaymentKind =>
  kind === "deposit" && offer.depositMinor !== undefined ? "deposit" : "full";

export type FeeRate = { bps: number; fixedMinor: number };

/** Stripe Mexico's card pricing, as configured: base, foreign-card and conversion surcharges, fixed part per currency. */
export type CardFees = {
  bps: number;
  internationalBps: number;
  conversionBps: number;
  fixedMinor: Record<OnlineCurrency, number>;
};

/**
 * The card fee to estimate for a currency. Pesos are estimated as a domestic card. Dollars always pay
 * Stripe's 2% conversion (the platform settles in pesos) and are estimated as a foreign card (+0.5%),
 * the usual case for dollar payers; the fixed part is configured in each currency.
 */
export function cardFeeRate(currency: OnlineCurrency, fees: CardFees): FeeRate {
  if (currency === "MXN") {
    return { bps: fees.bps, fixedMinor: fees.fixedMinor.MXN };
  }
  return {
    bps: fees.bps + fees.internationalBps + fees.conversionBps,
    fixedMinor: fees.fixedMinor.USD,
  };
}

/**
 * What the platform keeps so the barbershop absorbs Stripe's fee: `bps` of the amount plus a fixed part,
 * plus tax (IVA) on that fee, rounded up. Never more than the amount itself.
 */
export function applicationFee(
  amountMinor: number,
  rate: FeeRate,
  taxBps: number,
) {
  const fee = (amountMinor * rate.bps) / 10_000 + rate.fixedMinor;
  const withTax = Math.ceil((fee * (10_000 + taxBps)) / 10_000);
  return Math.min(amountMinor, withTax);
}

/** Bank transfers take longer: only offered when the hold ends before the appointment starts. */
export function holdEnds(
  method: Exclude<PaymentMethod, "spei">,
  now: number,
  holdMinutes: { card: number; bank_transfer: number },
) {
  return new Date(now + holdMinutes[method] * 60_000);
}

export const transferFits = (startAt: Date, deadline: Date) =>
  deadline.getTime() <= startAt.getTime();

/**
 * How much of an online payment goes back when the appointment is cancelled. The barbershop
 * cancelling returns everything left; the customer cancelling in time (before the branch's
 * `cancelNoticeMin`) gets it back minus Stripe's fee (`stripeFeeMinor`, not refundable); later, the
 * payment is kept.
 */
export function refundOnCancel(input: {
  leftMinor: number;
  stripeFeeMinor: number;
  by: "customer" | "staff";
  startAt: Date;
  cancelNoticeMin: number;
  now: number;
}) {
  if (input.leftMinor <= 0) return 0;
  if (input.by === "staff") return input.leftMinor;
  const inTime =
    input.now <= input.startAt.getTime() - input.cancelNoticeMin * 60_000;
  return inTime ? customerRefundable(input.leftMinor, input.stripeFeeMinor) : 0;
}

/** What a customer gets back cancelling in time: what is left, minus Stripe's fee. */
export const customerRefundable = (leftMinor: number, stripeFeeMinor: number) =>
  Math.max(0, leftMinor - stripeFeeMinor);

/**
 * Fee owed by the barbershop and still uncollected, added on top of the next charge's fee. Never so
 * much that the shop would get nothing from the charge.
 */
export const debtToCollect = (
  debtMinor: number,
  amountMinor: number,
  feeMinor: number,
) => Math.max(0, Math.min(debtMinor, amountMinor - feeMinor));

/**
 * After a refund, the part the barbershop's transfer couldn't cover (the fee the platform kept). The
 * shop owes all of it when the shop cancelled or refunded; otherwise only the old debt this payment
 * had collected comes back, since the customer paid the fee.
 */
export function debtAfterRefund(input: {
  refundMinor: number;
  reversedMinor: number;
  debtCollectedMinor: number;
  shopPays: boolean;
}) {
  const shortfall = Math.max(0, input.refundMinor - input.reversedMinor);
  return input.shopPays
    ? shortfall
    : Math.min(shortfall, input.debtCollectedMinor);
}
