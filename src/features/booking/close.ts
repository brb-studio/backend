import {
  type AppointmentDoc,
  type COUNTER_METHODS,
  forTenant,
} from "../../db/scoped";
import { AppError, type Auth } from "../../shared/http";
import { resolveCommission } from "../platform/commission";
import { dueAtCounter } from "./counter";

export const notConfirmed = () =>
  new AppError(409, "NOT_CONFIRMED", "Only confirmed appointments can change");

export async function closeAppointment(
  auth: Auth,
  appointment: AppointmentDoc,
  status: "completed" | "no_show",
  paidWith?: (typeof COUNTER_METHODS)[number],
  now = new Date(),
) {
  if (appointment.startAt > now) {
    throw new AppError(409, "NOT_STARTED", "It hasn't started yet");
  }
  const t = forTenant(auth.tenantId);
  const due = status === "completed" ? dueAtCounter(appointment) : 0;
  if (due > 0 && !paidWith) {
    throw new AppError(
      422,
      "PAYMENT_METHOD_REQUIRED",
      "Say how the customer paid what was left",
    );
  }
  const barber =
    status === "completed"
      ? await t.barbers.findOne({ _id: appointment.barberId })
      : null;
  const commission = resolveCommission(
    { ...appointment, status },
    barber?.commissionBps,
  );
  const result = await t.appointments.updateOne(
    { _id: appointment._id, status: "confirmed" },
    {
      $set: {
        status,
        ...(commission && {
          commission: {
            bps: commission.bps,
            amountMinor: commission.amountMinor,
          },
        }),
        ...(due > 0 &&
          paidWith && {
            counter: {
              method: paidWith,
              amountMinor: due,
              receivedBy: auth.userId,
              at: now,
            },
          }),
        updatedAt: now,
      },
    },
  );
  if (result.modifiedCount === 0) throw notConfirmed();
}
