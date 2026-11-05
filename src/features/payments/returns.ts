import type { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  forTenant,
  type TenantDoc,
  transaction,
} from "../../db/scoped";
import { AppError } from "../../shared/http";
import { onlineEntry } from "../money/rules";

const notRefundable = () =>
  new AppError(409, "NOT_REFUNDABLE", "Only paid payments are refunded");

export async function returnTransfer(
  tenant: Pick<TenantDoc, "_id">,
  appointment: AppointmentDoc,
  by: ObjectId,
  input: { amountMinor?: number | undefined; reference?: string | undefined },
) {
  const t = forTenant(tenant._id);
  const paymentId = appointment.payment?.paymentId;
  const payment = paymentId
    ? await t.payments.findOne({ _id: paymentId, method: "spei" })
    : null;
  if (payment?.status !== "paid") throw notRefundable();
  const already = appointment.payment?.refundedMinor ?? 0;
  const left = payment.amountMinor - already;
  const amount = input.amountMinor ?? left;
  if (amount < 1 || amount > left) {
    throw new AppError(
      422,
      "REFUND_TOO_LARGE",
      "That is more than what is left to refund",
    );
  }
  const refunded = already + amount;
  const full = refunded >= payment.amountMinor;
  const now = new Date();
  await transaction(async (session) => {
    const ticket = await t.appointments.updateOne(
      {
        _id: appointment._id,
        "payment.paymentId": payment._id,
        ...(already > 0
          ? { "payment.refundedMinor": already }
          : { "payment.refundedMinor": { $exists: false } }),
      },
      {
        $set: {
          "payment.refundedMinor": refunded,
          ...(full && { "payment.status": "refunded" }),
          updatedAt: now,
        },
      },
      { session },
    );
    if (ticket.matchedCount === 0) throw notRefundable();
    await t.payments.updateOne(
      { _id: payment._id, status: "paid" },
      {
        ...(full && { $set: { status: "refunded" } }),
        $push: {
          history: {
            status: full ? "refunded" : "paid",
            at: now,
            by,
            note: `returned ${amount}`,
          },
        },
      },
      { session },
    );
    await t.ledgerEntries.insertOne(
      onlineEntry(
        appointment,
        payment,
        now,
        "refund",
        amount,
        `refund:${payment._id.toHexString()}:${refunded}`,
        {
          recordedBy: by,
          ...(input.reference && { reference: input.reference }),
        },
      ),
      { session },
    );
  });
  return {
    appointmentId: appointment._id.toHexString(),
    paymentId: payment._id.toHexString(),
    method: payment.method,
    status: full ? "refunded" : "paid",
    amountMinor: payment.amountMinor,
    refundedMinor: refunded,
    currency: payment.currency,
  };
}
