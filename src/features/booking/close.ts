import {
  type AppointmentDoc,
  type COUNTER_METHODS,
  forTenant,
  transaction,
} from "../../db/scoped";
import { AppError, type Auth } from "../../shared/http";
import { counterEntry } from "../money/rules";
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
  const counter =
    due > 0 && paidWith
      ? { method: paidWith, amountMinor: due, receivedBy: auth.userId, at: now }
      : undefined;
  await transaction(async (session) => {
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
          ...(counter && { counter }),
          updatedAt: now,
        },
      },
      { session },
    );
    if (result.modifiedCount === 0) throw notConfirmed();
    if (counter) {
      await t.ledgerEntries.insertOne(counterEntry(appointment, counter), {
        session,
      });
    }
  });
}
