import { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  forTenant,
  type PaymentDoc,
  platform,
  type StripePaymentInfo,
  type TenantDb,
  type TenantDoc,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError } from "../../shared/http";
import {
  attachIntent,
  type HoldEnd,
  moveFeeDebt,
  OPEN,
  releaseHold,
  stripeFeeOf,
  updateInstructions,
} from "./holds";
import { noteFailure, recordDispute, recordRefund, settlePaid } from "./ledger";
import { debtAfterRefund, refundOnCancel } from "./rules";
import { providerError, stripe } from "./stripe/client";
import {
  charge as chargeSchema,
  dispute as disputeSchema,
  paymentIntent,
  refund as refundSchema,
  type StripePaymentIntent,
  transferReversal,
  transfer as transferSchema,
} from "./stripe/types";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

function log(event: string, data: Record<string, unknown>) {
  console.error(JSON.stringify({ level: "warn", event, ...data }));
}

export function instructionsOf(
  pi: StripePaymentIntent,
): StripePaymentInfo["instructions"] {
  const shown = pi.next_action?.display_bank_transfer_instructions;
  const spei = shown?.financial_addresses.find((a) => a.spei)?.spei;
  if (!shown || !spei) return undefined;
  return {
    clabe: spei.clabe,
    amountRemainingMinor: shown.amount_remaining,
    ...(spei.bank_name && { bankName: spei.bank_name }),
    ...(shown.reference && { reference: shown.reference }),
    ...(shown.hosted_instructions_url && {
      hostedUrl: shown.hosted_instructions_url,
    }),
  };
}

const cancelIntent = (intentId: string) =>
  stripe
    .post(
      paymentIntent,
      `/v1/payment_intents/${encodeURIComponent(intentId)}/cancel`,
      { cancellation_reason: "abandoned" },
    )
    .catch((err: unknown) =>
      log("stripe_cancel_failed", {
        intentId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );

export async function abandon(
  tenant: TenantDoc,
  appointmentId: ObjectId,
  reason: HoldEnd,
) {
  const intentId = await releaseHold(tenant, appointmentId, reason);
  if (intentId) await cancelIntent(intentId);
}

/** Cancels every hold past its deadline (and its charge at Stripe). Runs before reading or taking slots. */
export async function sweepHolds(tenant: TenantDoc, now = new Date()) {
  const stale = await collect(
    forTenant(tenant._id)
      .appointments.find({
        status: "pending_payment",
        paymentDeadline: { $lte: now },
      })
      .project<Pick<AppointmentDoc, "_id">>({ _id: 1 })
      .limit(100),
  );
  for (const { _id } of stale) {
    await abandon(tenant, _id, "payment_expired");
  }
}

/** The customer gives up on a booking they haven't paid: the slot is freed at once. */
export const cancelHold = (tenant: TenantDoc, appointmentId: ObjectId) =>
  abandon(tenant, appointmentId, "cancelled_by_customer");

export async function currentPayment(t: TenantDb, appointment: AppointmentDoc) {
  const paymentId = appointment.payment?.paymentId;
  if (appointment.payment?.provider !== "stripe" || !paymentId) {
    throw notFound();
  }
  const payment = await t.payments.findOne({ _id: paymentId });
  if (!payment?.stripe) throw notFound();
  return payment;
}

/**
 * Returns money to the customer, then takes exactly that much back from the shop's transfer (as far
 * as it goes; Stripe's `reverse_transfer` would only take a proportional share). What the transfer
 * can't cover is the fee the platform kept: the shop owes it when `shopPays` (it cancelled or
 * refunded), added to the fee of its next payments.
 */
export async function refundPayment(
  tenant: TenantDoc,
  payment: PaymentDoc,
  amountMinor: number,
  note: string,
  options: { shopPays: boolean; by?: ObjectId },
) {
  const intentId = payment.stripe?.paymentIntentId;
  const already = payment.stripe?.refundedMinor ?? 0;
  if (!intentId || payment.status !== "paid") {
    throw new AppError(
      409,
      "NOT_REFUNDABLE",
      "Only paid payments are refunded",
    );
  }
  if (amountMinor < 1 || amountMinor > payment.amountMinor - already) {
    throw new AppError(
      422,
      "REFUND_TOO_LARGE",
      "That is more than what is left to refund",
    );
  }
  const key = `${payment._id.toHexString()}-${already}-${amountMinor}`;
  const metadata = {
    tenantId: tenant._id.toHexString(),
    paymentId: payment._id.toHexString(),
  };
  let transferId: string | undefined;
  try {
    const pi = await fetchIntent(intentId);
    transferId =
      typeof pi.latest_charge === "object"
        ? (pi.latest_charge?.transfer ?? undefined)
        : undefined;
    await stripe.post(
      refundSchema,
      "/v1/refunds",
      { payment_intent: intentId, amount: amountMinor, metadata },
      `refund-${key}`,
    );
  } catch (err) {
    throw providerError(err, "stripe_refund_failed");
  }
  let reversedMinor = 0;
  if (transferId) {
    try {
      const sent = await stripe.get(
        transferSchema,
        `/v1/transfers/${encodeURIComponent(transferId)}`,
      );
      const reversible = Math.min(
        amountMinor,
        sent.amount - sent.amount_reversed,
      );
      if (reversible > 0) {
        await stripe.post(
          transferReversal,
          `/v1/transfers/${encodeURIComponent(transferId)}/reversals`,
          { amount: reversible, metadata },
          `reversal-${key}`,
        );
        reversedMinor = reversible;
      }
    } catch (err) {
      // The customer has the money back; the shop still holds its share. Owed as debt, never lost.
      log("stripe_reversal_failed", {
        paymentId: payment._id.toHexString(),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const debt =
    reversedMinor === 0 && transferId
      ? amountMinor
      : debtAfterRefund({
          refundMinor: amountMinor,
          reversedMinor,
          debtCollectedMinor: payment.stripe?.debtMinor ?? 0,
          shopPays: options.shopPays,
        });
  // Recorded apart from the refunded total: Stripe's `charge.refunded` may have recorded that first.
  if (reversedMinor > 0) {
    await forTenant(tenant._id).payments.updateOne(
      { _id: payment._id },
      { $inc: { "stripe.reversedMinor": reversedMinor } },
    );
  }
  await recordRefund(tenant, payment, already + amountMinor, note, options.by);
  await moveFeeDebt(tenant._id, debt, payment.currency);
}

/** After a paid booking is cancelled: refunds what the policy says; a failure is logged, never undoes the cancel. */
export async function refundAfterCancel(
  tenant: TenantDoc,
  appointment: AppointmentDoc,
  by: "customer" | "staff",
  cancelNoticeMin: number,
) {
  const paymentId = appointment.payment?.paymentId;
  if (appointment.payment?.provider !== "stripe" || !paymentId) return;
  const t = forTenant(tenant._id);
  const payment = await t.payments.findOne({ _id: paymentId });
  if (payment?.status !== "paid") return;
  const amount = refundOnCancel({
    leftMinor: payment.amountMinor - (payment.stripe?.refundedMinor ?? 0),
    stripeFeeMinor: stripeFeeOf(payment),
    by,
    startAt: appointment.startAt,
    cancelNoticeMin,
    now: Date.now(),
  });
  if (amount === 0) return;
  await refundPayment(tenant, payment, amount, `cancelled_by_${by}`, {
    shopPays: by === "staff",
  }).catch((err: unknown) =>
    log("refund_after_cancel_failed", {
      paymentId: paymentId.toHexString(),
      message: err instanceof Error ? err.message : String(err),
    }),
  );
}

const cardOf = (pi: StripePaymentIntent) => {
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const card = charge?.payment_method_details?.card;
  return {
    ...(card?.brand && { cardBrand: card.brand }),
    ...(card?.last4 && /^\d{4}$/.test(card.last4) && { cardLast4: card.last4 }),
  };
};

const HOLD_ENDS: string[] = [
  "payment_expired",
  "cancelled_by_customer",
  "payment_not_started",
] satisfies HoldEnd[];

/**
 * Money that arrived after its hold ended goes back in full. Decided from what is stored, not from the
 * event, so a redelivered event retries a refund that failed and never refunds twice.
 */
async function refundIfLate(tenant: TenantDoc, payment: PaymentDoc) {
  const t = forTenant(tenant._id);
  const [paid, appointment] = await Promise.all([
    t.payments.findOne({ _id: payment._id }),
    t.appointments.findOne({ _id: payment.appointmentId }),
  ]);
  const left = paid ? paid.amountMinor - (paid.stripe?.refundedMinor ?? 0) : 0;
  const holdEnded =
    appointment?.status === "cancelled" &&
    HOLD_ENDS.includes(appointment.cancelReason ?? "");
  // A payment the customer had replaced (card ↔ transfer) that still went through.
  const replaced =
    appointment && !appointment.payment?.paymentId?.equals(payment._id);
  if (paid?.status === "paid" && left > 0 && (holdEnded || replaced)) {
    // Nobody's fault but the clock: the platform absorbs the fee.
    await refundPayment(tenant, paid, left, "late_payment", {
      shopPays: false,
    });
  }
}

/** Acts on the current state of a PaymentIntent of ours. Every transition is conditional: replays are no-ops. */
export async function settleIntent(
  tenant: TenantDoc,
  payment: PaymentDoc,
  pi: StripePaymentIntent,
) {
  if (pi.status === "succeeded") {
    if (pi.amount_received < payment.amountMinor) {
      log("stripe_underpaid", {
        paymentId: payment._id.toHexString(),
        received: pi.amount_received,
      });
      return;
    }
    await settlePaid(tenant, payment, {
      amountMinor: pi.amount_received,
      ...cardOf(pi),
    });
    await refundIfLate(tenant, payment);
    return;
  }
  if (pi.status === "requires_action") {
    const instructions = instructionsOf(pi);
    if (instructions) {
      await updateInstructions(
        tenant,
        payment,
        instructions,
        pi.amount - instructions.amountRemainingMinor,
      );
    }
    return;
  }
  if (pi.status === "canceled") {
    if (OPEN.some((s) => s === payment.status)) {
      await abandon(tenant, payment.appointmentId, "payment_expired");
    }
    return;
  }
  if (pi.status === "requires_payment_method") {
    await noteFailure(tenant, payment, "card_declined");
  }
}

/**
 * Finds our payment behind a PaymentIntent and checks it really is ours: tenant and payment from the
 * metadata, then the amount, currency and destination against what we stored.
 */
async function paymentOf(pi: StripePaymentIntent) {
  const { tenantId, paymentId } = pi.metadata;
  if (!tenantId || !paymentId || !ObjectId.isValid(tenantId)) return undefined;
  if (!ObjectId.isValid(paymentId)) return undefined;
  const tenant = await platform.tenants.findOne({
    _id: new ObjectId(tenantId),
  });
  if (!tenant) return undefined;
  const payment = await forTenant(tenant._id).payments.findOne({
    _id: new ObjectId(paymentId),
  });
  const info = payment?.stripe;
  const matches =
    payment &&
    info &&
    (info.paymentIntentId ?? pi.id) === pi.id &&
    pi.amount === payment.amountMinor &&
    pi.currency.toUpperCase() === payment.currency &&
    pi.transfer_data?.destination === info.accountId;
  if (!matches) {
    log("stripe_intent_mismatch", { intentId: pi.id, paymentId });
    return undefined;
  }
  return { tenant, payment };
}

const fetchIntent = (intentId: string) =>
  stripe.get(
    paymentIntent,
    `/v1/payment_intents/${encodeURIComponent(intentId)}`,
    { expand: ["latest_charge"] },
  );

/** Webhook: a PaymentIntent changed. Reads it again from Stripe so a stale or reordered event can't mislead. */
export async function onIntentEvent(intentId: string) {
  const pi = await fetchIntent(intentId);
  const found = await paymentOf(pi);
  if (!found) return;
  if (!found.payment.stripe?.paymentIntentId) {
    await attachIntent(found.tenant, found.payment, {
      paymentIntentId: pi.id,
    });
  }
  await settleIntent(found.tenant, found.payment, pi);
}

/** Webhook: a refund made here or in Stripe's dashboard. */
export async function onChargeRefunded(charge: unknown) {
  const parsed = chargeSchema.safeParse(charge);
  if (!parsed.success || !parsed.data.payment_intent) return;
  const found = await paymentOf(await fetchIntent(parsed.data.payment_intent));
  if (!found) return;
  await recordRefund(
    found.tenant,
    found.payment,
    parsed.data.amount_refunded,
    "refund",
  );
}

/** Webhook: the cardholder opened a chargeback. */
export async function onDispute(dispute: unknown) {
  const parsed = disputeSchema.safeParse(dispute);
  if (!parsed.success || !parsed.data.payment_intent) return;
  const found = await paymentOf(await fetchIntent(parsed.data.payment_intent));
  if (!found) return;
  await recordDispute(found.tenant, found.payment, parsed.data.id);
}
