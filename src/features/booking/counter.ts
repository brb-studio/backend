import type { AppointmentDoc } from "../../db/scoped";

const COLLECTED = new Set(["paid", "disputed", "refunded"]);

export const paidBefore = (payment: AppointmentDoc["payment"]) =>
  payment && COLLECTED.has(payment.status)
    ? payment.amountMinor - (payment.refundedMinor ?? 0)
    : 0;

export const dueAtCounter = (
  a: Pick<AppointmentDoc, "totalMinor" | "payment">,
) => Math.max(0, a.totalMinor - paidBefore(a.payment));
