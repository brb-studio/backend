import type { ObjectId } from "mongodb";
import {
  forTenant,
  type PaymentDoc,
  type TenantDoc,
  transaction,
} from "../../db/scoped";
import {
  notifyBarber,
  notifyOwners,
  pushAfterCommit,
} from "../notifications/service";
import { OPEN } from "./holds";

/**
 * Stripe says the money arrived. The payment becomes `paid` and its booking `confirmed`, with the
 * barber's notice, in one transaction. If the hold had already ended, the booking stays cancelled and
 * the caller refunds (`late`).
 */
export async function settlePaid(
  tenant: TenantDoc,
  payment: PaymentDoc,
  received: { amountMinor: number; cardBrand?: string; cardLast4?: string },
) {
  const t = forTenant(tenant._id);
  const now = new Date();
  const card = {
    ...(received.cardBrand && { "stripe.cardBrand": received.cardBrand }),
    ...(received.cardLast4 && { "stripe.cardLast4": received.cardLast4 }),
  };
  const ticket = {
    "payment.status": "paid",
    "payment.paidAt": now,
    ...(received.cardBrand && { "payment.cardBrand": received.cardBrand }),
    ...(received.cardLast4 && { "payment.cardLast4": received.cardLast4 }),
    updatedAt: now,
  } as const;
  const outcome = await transaction(async (session) => {
    const paid = await t.payments.updateOne(
      { _id: payment._id, status: { $in: [...OPEN, "expired"] } },
      {
        $set: {
          status: "paid",
          resolvedAt: now,
          "stripe.receivedMinor": received.amountMinor,
          ...card,
        },
        $push: { history: { status: "paid", at: now } },
      },
      { session },
    );
    if (paid.matchedCount === 0) return undefined;
    const confirmed = await t.appointments.findOneAndUpdate(
      {
        _id: payment.appointmentId,
        status: "pending_payment",
        "payment.paymentId": payment._id,
      },
      { $set: { status: "confirmed", ...ticket } },
      { session, returnDocument: "after" },
    );
    if (!confirmed) {
      await t.appointments.updateOne(
        { _id: payment.appointmentId, "payment.paymentId": payment._id },
        { $set: ticket },
        { session },
      );
      return { late: true, notes: [] };
    }
    const barber = await t.barbers.findOne(
      { _id: confirmed.barberId },
      { session },
    );
    const branch = await t.branches.findOne(
      { _id: confirmed.branchId },
      { session },
    );
    const customer = await t.customers.findOne(
      { _id: confirmed.customerId },
      { session },
    );
    const note =
      barber && branch
        ? await notifyBarber(
            t,
            {
              type: "appointment.booked",
              appointment: confirmed,
              barber,
              branch,
              customerName: customer?.name ?? "",
            },
            session,
          )
        : undefined;
    return { late: false, notes: [note] };
  });
  if (outcome) pushAfterCommit(tenant, outcome.notes);
  return outcome;
}

/** Keeps the refunded total as Stripe reports it; a repeated report changes nothing. */
export async function recordRefund(
  tenant: TenantDoc,
  payment: PaymentDoc,
  refundedMinor: number,
  note: string,
  by?: ObjectId,
) {
  const t = forTenant(tenant._id);
  const now = new Date();
  const full = refundedMinor >= payment.amountMinor;
  const status = full ? "refunded" : payment.status;
  await transaction(async (session) => {
    const changed = await t.payments.updateOne(
      {
        _id: payment._id,
        status: { $in: ["paid", "disputed", "refunded"] },
        $or: [
          { "stripe.refundedMinor": { $exists: false } },
          { "stripe.refundedMinor": { $lt: refundedMinor } },
        ],
      },
      {
        $set: {
          "stripe.refundedMinor": refundedMinor,
          ...(full && { status: "refunded" }),
        },
        $push: { history: { status, at: now, note, ...(by && { by }) } },
      },
      { session },
    );
    if (changed.matchedCount === 0) return;
    await t.appointments.updateOne(
      { _id: payment.appointmentId, "payment.paymentId": payment._id },
      {
        $set: {
          "payment.refundedMinor": refundedMinor,
          ...(full && { "payment.status": "refunded" }),
          updatedAt: now,
        },
      },
      { session },
    );
  });
}

/** A chargeback: the payment is `disputed` and owners and admins are told, in one transaction. */
export async function recordDispute(
  tenant: TenantDoc,
  payment: PaymentDoc,
  disputeId: string,
) {
  const t = forTenant(tenant._id);
  const now = new Date();
  const notes = await transaction(async (session) => {
    const changed = await t.payments.updateOne(
      { _id: payment._id, status: { $in: ["paid", "refunded"] } },
      {
        $set: { status: "disputed", "stripe.disputeId": disputeId },
        $push: { history: { status: "disputed", at: now, note: disputeId } },
      },
      { session },
    );
    if (changed.matchedCount === 0) return [];
    const appointment = await t.appointments.findOneAndUpdate(
      { _id: payment.appointmentId, "payment.paymentId": payment._id },
      { $set: { "payment.status": "disputed", updatedAt: now } },
      { session, returnDocument: "after" },
    );
    if (!appointment) return [];
    const branch = await t.branches.findOne(
      { _id: appointment.branchId },
      { session },
    );
    const customer = await t.customers.findOne(
      { _id: appointment.customerId },
      { session },
    );
    return notifyOwners(
      t,
      {
        type: "payment.disputed",
        appointment,
        branch: { name: branch?.name ?? "" },
        customerName: customer?.name ?? "",
      },
      session,
    );
  });
  pushAfterCommit(tenant, notes);
}

/** A card attempt that failed: still payable with another card until the deadline. */
export async function noteFailure(
  tenant: TenantDoc,
  payment: PaymentDoc,
  reason: string,
) {
  await forTenant(tenant._id).payments.updateOne(
    { _id: payment._id, status: { $in: [...OPEN] } },
    {
      $push: {
        history: {
          status: payment.status,
          at: new Date(),
          note: `failed: ${reason}`.slice(0, 500),
        },
      },
    },
  );
}
