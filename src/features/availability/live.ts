import type { Filter } from "mongodb";
import type { AppointmentDoc } from "../../db/scoped";

/**
 * Appointments that take a slot: confirmed ones, and online bookings still inside their payment window.
 * A hold past its deadline frees the slot even before the sweep cancels it.
 */
export const takesSlot = (now = new Date()): Filter<AppointmentDoc> => ({
  $or: [
    { status: "confirmed" },
    { status: "pending_payment", paymentDeadline: { $gt: now } },
  ],
});
