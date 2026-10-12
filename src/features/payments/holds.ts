import { type ClientSession, ObjectId } from "mongodb";
import { config } from "../../config";
import {
  type AppointmentDoc,
  forTenant,
  type PaymentDoc,
  type PaymentKind,
  platform,
  type StripePaymentInfo,
  type TenantDoc,
  transaction,
} from "../../db/scoped";
import { AppError } from "../../shared/http";
import { release } from "../promotions/service";
import { depositOf } from "./connect";
import {
  amountFor,
  applicationFee,
  cardFeeRate,
  customerRefundable,
  debtToCollect,
  type FeeRate,
  isOnlineCurrency,
  kindOf,
  methodsFor,
  type OnlineCurrency,
  type OnlineOffer,
  onlineOffer,
} from "./rules";

export type OnlineMethod = "card" | "bank_transfer";

/** What the customer chose when booking online; the amount always comes from the booking itself. */
export type HoldRequest = {
  method: OnlineMethod;
  kind: PaymentKind;
  deadline: Date;
  accountId: string;
};

/** Payments still waiting for the money. */
export const OPEN = ["pending", "awaiting_transfer"] as const;

export const unavailable = () =>
  new AppError(
    409,
    "ONLINE_PAYMENT_UNAVAILABLE",
    "This visit can't be paid online",
  );

const feeRate = (method: OnlineMethod, currency: OnlineCurrency): FeeRate =>
  method === "card"
    ? cardFeeRate(currency, {
        bps: config.STRIPE_CARD_FEE_BPS,
        internationalBps: config.STRIPE_INTL_CARD_FEE_BPS,
        conversionBps: config.STRIPE_FX_FEE_BPS,
        fixedMinor: {
          MXN: config.STRIPE_CARD_FEE_FIXED_MINOR,
          USD: config.STRIPE_CARD_FEE_FIXED_MINOR_USD,
        },
      })
    : {
        bps: config.STRIPE_TRANSFER_FEE_BPS,
        fixedMinor: config.STRIPE_TRANSFER_FEE_FIXED_MINOR,
      };

/**
 * What paying online would charge and give back for a quoted total, before anything is booked: the
 * same rules the booking applies (deposit, minimum, Stripe's fee per method and currency), so what
 * the customer sees before "Continue" is what the API will charge. The shop's fee debt never shows:
 * the customer doesn't pay it.
 */
export function onlineOptions(tenant: TenantDoc, totalMinor: number) {
  if (!isOnlineCurrency(tenant.currency)) return undefined;
  const currency = tenant.currency;
  const offer = onlineOffer(totalMinor, depositOf(tenant), currency);
  if (!offer) return undefined;
  const kinds: PaymentKind[] =
    offer.depositMinor !== undefined ? ["deposit", "full"] : ["full"];
  return {
    required: offer.required,
    fullMinor: offer.fullMinor,
    ...(offer.depositMinor !== undefined && {
      depositMinor: offer.depositMinor,
    }),
    options: methodsFor(currency).flatMap((method) =>
      kinds.map((kind) => {
        const amountMinor = amountFor(offer, kind);
        const feeMinor = applicationFee(
          amountMinor,
          feeRate(method, currency),
          config.STRIPE_FEE_TAX_BPS,
        );
        return {
          kind,
          method,
          amountMinor,
          refundableMinor: customerRefundable(amountMinor, feeMinor),
        };
      }),
    ),
  };
}

/** The currency of an online payment, or why it can't be paid that way (SPEI is pesos only). */
export function onlineCurrencyFor(currency: string, method: OnlineMethod) {
  if (!isOnlineCurrency(currency)) throw unavailable();
  if (!methodsFor(currency).includes(method)) {
    throw new AppError(
      409,
      "METHOD_UNAVAILABLE",
      "This barbershop can't take that payment method",
    );
  }
  return currency;
}

export function newPayment(
  appointment: Pick<
    AppointmentDoc,
    "_id" | "tenantId" | "currency" | "totalMinor"
  >,
  offer: OnlineOffer,
  hold: HoldRequest,
  now: Date,
  /** What the shop still owes in fees: collected on top of this payment's fee, as far as it fits. */
  feeDebtMinor = 0,
): PaymentDoc {
  const amountMinor = amountFor(offer, hold.kind);
  const feeMinor = applicationFee(
    amountMinor,
    feeRate(hold.method, onlineCurrencyFor(appointment.currency, hold.method)),
    config.STRIPE_FEE_TAX_BPS,
  );
  const debtMinor = debtToCollect(feeDebtMinor, amountMinor, feeMinor);
  return {
    _id: new ObjectId(),
    tenantId: appointment.tenantId,
    appointmentId: appointment._id,
    method: hold.method,
    kind: kindOf(offer, hold.kind),
    status: "pending",
    amountMinor,
    currency: appointment.currency,
    stripe: {
      accountId: hold.accountId,
      applicationFeeMinor: feeMinor + debtMinor,
      ...(debtMinor > 0 && { debtMinor }),
    },
    createdAt: now,
    expiresAt: hold.deadline,
    history: [{ status: "pending", at: now }],
  };
}

/** Stripe's fee in a payment's application fee: what the customer never gets back. */
export const stripeFeeOf = (payment: Pick<PaymentDoc, "stripe">) =>
  (payment.stripe?.applicationFeeMinor ?? 0) - (payment.stripe?.debtMinor ?? 0);

/** The shop's fee debt as of this transaction. */
/** The shop's fee debt as of this transaction, in the payment's currency: a debt in another currency waits. */
async function feeDebtOf(
  tenantId: ObjectId,
  currency: string,
  session: ClientSession,
) {
  const tenant = await platform.tenants.findOne(
    { _id: tenantId },
    { session, projection: { stripeConnect: 1, currency: 1 } },
  );
  const debt = tenant?.stripeConnect;
  // A debt saved before it carried a currency is in the shop's currency.
  const debtCurrency = debt?.feeDebtCurrency ?? tenant?.currency;
  return debtCurrency === currency ? (debt?.feeDebtMinor ?? 0) : 0;
}

/**
 * Moves the shop's fee debt: negative when a payment takes some to collect, positive when that
 * payment didn't happen (the debt comes back) or a refund left the platform short.
 */
export async function moveFeeDebt(
  tenantId: ObjectId,
  deltaMinor: number,
  currency: string,
  session?: ClientSession,
) {
  if (deltaMinor === 0) return;
  // A debt keeps its currency: amounts in different currencies are never added together.
  const sameCurrency =
    deltaMinor < 0
      ? {
          "stripeConnect.feeDebtMinor": { $gte: -deltaMinor },
          $or: [
            { "stripeConnect.feeDebtCurrency": currency },
            { "stripeConnect.feeDebtCurrency": { $exists: false }, currency },
          ],
        }
      : {
          $or: [
            { "stripeConnect.feeDebtCurrency": currency },
            { "stripeConnect.feeDebtCurrency": { $exists: false }, currency },
            { "stripeConnect.feeDebtMinor": { $in: [0, null] } },
          ],
        };
  const moved = await platform.tenants.updateOne(
    {
      _id: tenantId,
      "stripeConnect.accountId": { $exists: true },
      ...sameCurrency,
    },
    {
      $inc: { "stripeConnect.feeDebtMinor": deltaMinor },
      $set: { "stripeConnect.feeDebtCurrency": currency },
    },
    { session },
  );
  if (moved.matchedCount > 0) return;
  if (deltaMinor < 0) {
    throw new Error("fee debt changed during the transaction");
  }
  console.error(
    JSON.stringify({
      level: "warn",
      event: "fee_debt_currency_mismatch",
      tenantId: tenantId.toHexString(),
      currency,
      amountMinor: deltaMinor,
    }),
  );
}

/**
 * Inside the booking transaction, with the price just computed: the payment an online booking makes
 * (taking the fee debt it will collect), nothing for a booking that doesn't pay, or why it can't be
 * booked this way.
 */
export async function planPayment(
  tenant: TenantDoc,
  appointment: Pick<
    AppointmentDoc,
    "_id" | "tenantId" | "currency" | "totalMinor"
  >,
  options: {
    online: boolean;
    hold?: HoldRequest;
    now: Date;
    session: ClientSession;
  },
) {
  const offer = options.online
    ? onlineOffer(
        appointment.totalMinor,
        depositOf(tenant),
        isOnlineCurrency(appointment.currency) ? appointment.currency : "MXN",
      )
    : undefined;
  if (!options.hold) {
    if (offer?.required) {
      throw new AppError(
        422,
        "PAYMENT_REQUIRED",
        "This barbershop asks for a payment to book online",
      );
    }
    return undefined;
  }
  if (!offer) throw unavailable();
  const payment = newPayment(
    appointment,
    offer,
    options.hold,
    options.now,
    await feeDebtOf(tenant._id, appointment.currency, options.session),
  );
  await moveFeeDebt(
    tenant._id,
    -(payment.stripe?.debtMinor ?? 0),
    payment.currency,
    options.session,
  );
  return payment;
}

/** The appointment's copy of its latest payment (the "ticket"). */
export const summaryOf = (
  payment: PaymentDoc,
): NonNullable<AppointmentDoc["payment"]> => ({
  provider: "stripe",
  paymentId: payment._id,
  method: payment.method,
  kind: payment.kind,
  status: payment.status,
  amountMinor: payment.amountMinor,
  applicationFeeMinor: payment.stripe?.applicationFeeMinor,
  ...(payment.stripe?.debtMinor && { debtMinor: payment.stripe.debtMinor }),
  ...(payment.stripe?.paymentIntentId && {
    intentId: payment.stripe.paymentIntentId,
  }),
});

/** Saves what Stripe returned when the charge was created. */
export async function attachIntent(
  tenant: TenantDoc,
  payment: PaymentDoc,
  info: Pick<
    StripePaymentInfo,
    "paymentIntentId" | "customerId" | "instructions"
  >,
) {
  const t = forTenant(tenant._id);
  const awaiting = info.instructions !== undefined;
  const now = new Date();
  await transaction(async (session) => {
    await t.payments.updateOne(
      { _id: payment._id, status: { $in: [...OPEN] } },
      {
        $set: {
          "stripe.paymentIntentId": info.paymentIntentId,
          ...(info.customerId && { "stripe.customerId": info.customerId }),
          ...(info.instructions && {
            "stripe.instructions": info.instructions,
            status: "awaiting_transfer",
          }),
        },
        ...(awaiting && {
          $push: { history: { status: "awaiting_transfer", at: now } },
        }),
      },
      { session },
    );
    await t.appointments.updateOne(
      { _id: payment.appointmentId, "payment.paymentId": payment._id },
      {
        $set: {
          "payment.intentId": info.paymentIntentId,
          ...(awaiting && { "payment.status": "awaiting_transfer" }),
          updatedAt: now,
        },
      },
      { session },
    );
  });
}

/** A transfer partly received or new instructions from Stripe: still waiting, with the amount left. */
export async function updateInstructions(
  tenant: TenantDoc,
  payment: PaymentDoc,
  instructions: NonNullable<StripePaymentInfo["instructions"]>,
  receivedMinor: number,
) {
  const t = forTenant(tenant._id);
  const now = new Date();
  await transaction(async (session) => {
    const changed = await t.payments.updateOne(
      { _id: payment._id, status: { $in: [...OPEN] } },
      {
        $set: {
          status: "awaiting_transfer",
          "stripe.instructions": instructions,
          "stripe.receivedMinor": receivedMinor,
        },
        ...(payment.status === "pending" && {
          $push: { history: { status: "awaiting_transfer", at: now } },
        }),
      },
      { session },
    );
    if (changed.matchedCount === 0) return;
    await t.appointments.updateOne(
      { _id: payment.appointmentId, "payment.paymentId": payment._id },
      { $set: { "payment.status": "awaiting_transfer", updatedAt: now } },
      { session },
    );
  });
}

export type HoldEnd =
  | "payment_expired"
  | "cancelled_by_customer"
  | "payment_not_started";

/**
 * Ends a hold that wasn't paid: the booking is cancelled, its promotion given back and its payment
 * expired, in one transaction. Returns the PaymentIntent to cancel at Stripe, if any.
 */
export async function releaseHold(
  tenant: TenantDoc,
  appointmentId: ObjectId,
  reason: HoldEnd,
  now = new Date(),
) {
  const t = forTenant(tenant._id);
  return transaction(async (session) => {
    const appointment = await t.appointments.findOneAndUpdate(
      { _id: appointmentId, status: "pending_payment" },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelReason: reason,
          "payment.status": "expired",
          updatedAt: now,
        },
      },
      { session, returnDocument: "before" },
    );
    if (!appointment) return undefined;
    if (appointment.promotion) {
      await release(t, appointment.promotion.promotionId, session);
    }
    const paymentId = appointment.payment?.paymentId;
    if (!paymentId) return undefined;
    const payment = await t.payments.findOneAndUpdate(
      { _id: paymentId, status: { $in: [...OPEN] } },
      {
        $set: { status: "expired", resolvedAt: now },
        $push: { history: { status: "expired", at: now, note: reason } },
      },
      { session, returnDocument: "after" },
    );
    // The debt this payment was going to collect is owed again.
    if (payment) {
      await moveFeeDebt(
        tenant._id,
        payment.stripe?.debtMinor ?? 0,
        payment.currency,
        session,
      );
    }
    return payment?.stripe?.paymentIntentId;
  });
}

/** Retires an unpaid payment the customer replaced by another one (changing card ↔ transfer). */
export async function replacePayment(
  tenant: TenantDoc,
  previous: PaymentDoc,
  build: (feeDebtMinor: number) => PaymentDoc,
) {
  const t = forTenant(tenant._id);
  const now = new Date();
  return transaction(async (session) => {
    const retired = await t.payments.updateOne(
      { _id: previous._id, status: { $in: [...OPEN] } },
      {
        $set: { status: "expired", resolvedAt: now },
        $push: { history: { status: "expired", at: now, note: "replaced" } },
      },
      { session },
    );
    if (retired.matchedCount === 0) {
      throw new AppError(
        409,
        "INVALID_TRANSITION",
        "This payment was already resolved",
      );
    }
    // The old payment's debt comes back, then the new one takes what it can collect.
    await moveFeeDebt(
      tenant._id,
      previous.stripe?.debtMinor ?? 0,
      previous.currency,
      session,
    );
    const next = build(await feeDebtOf(tenant._id, previous.currency, session));
    await moveFeeDebt(
      tenant._id,
      -(next.stripe?.debtMinor ?? 0),
      next.currency,
      session,
    );
    const { tenantId: _, ...doc } = next;
    await t.payments.insertOne(doc, { session });
    const moved = await t.appointments.updateOne(
      {
        _id: next.appointmentId,
        status: "pending_payment",
        "payment.paymentId": previous._id,
      },
      { $set: { payment: summaryOf(next), updatedAt: now } },
      { session },
    );
    if (moved.matchedCount === 0) {
      throw new AppError(
        409,
        "NOT_PENDING_PAYMENT",
        "This booking is no longer waiting for a payment",
      );
    }
    return next;
  });
}
