import { type AnyBulkWriteOperation, ObjectId } from "mongodb";
import { type AppointmentDoc, platform, transaction } from "../../db/scoped";
import { AppError, isDuplicate } from "../../shared/http";
import { resolveCommission } from "./commission";

export async function setCommissionRate(
  barberId: ObjectId,
  bps: number | null,
  tenantId?: ObjectId,
) {
  const result = await platform.barbers.updateOne(
    { _id: barberId, ...(tenantId && { tenantId }) },
    bps === null
      ? { $unset: { commissionBps: "" }, $set: { updatedAt: new Date() } }
      : { $set: { commissionBps: bps, updatedAt: new Date() } },
  );
  if (result.matchedCount === 0)
    throw new AppError(404, "NOT_FOUND", "Not found");
}

export async function createPayout(
  staffId: ObjectId,
  input: {
    barberId: ObjectId;
    appointmentIds: ObjectId[];
    reference?: string;
    paidAt?: Date;
  },
  tenantId?: ObjectId,
) {
  const barber = await platform.barbers.findOne({
    _id: input.barberId,
    ...(tenantId && { tenantId }),
  });
  if (!barber) throw new AppError(404, "NOT_FOUND", "Not found");
  const tenant = await platform.tenants.findOne({ _id: barber.tenantId });
  if (!tenant) throw new AppError(404, "NOT_FOUND", "Not found");
  const ids = [
    ...new Map(
      input.appointmentIds.map((id) => [id.toHexString(), id]),
    ).values(),
  ];
  const now = new Date();
  try {
    return await transaction(async (session) => {
      const payoutId = new ObjectId();
      let amountMinor = 0;
      const marks: AnyBulkWriteOperation<AppointmentDoc>[] = [];
      const cursor = platform.appointments.find(
        {
          _id: { $in: ids },
          tenantId: barber.tenantId,
          barberId: barber._id,
          status: "completed",
        },
        { session },
      );
      let found = 0;
      for await (const appointment of cursor) {
        found++;
        if (appointment.payoutId) {
          throw new AppError(
            409,
            "ALREADY_PAID",
            "An appointment was already paid",
          );
        }
        const commission = resolveCommission(appointment, barber.commissionBps);
        if (!commission) {
          throw new AppError(
            409,
            "COMMISSION_NOT_CONFIGURED",
            "Set the barber's commission before paying",
          );
        }
        amountMinor += commission.amountMinor;
        // Marks the appointment as settled and freezes its commission in one write.
        marks.push({
          updateOne: {
            filter: { _id: appointment._id, payoutId: { $exists: false } },
            update: {
              $set: {
                payoutId,
                commission: {
                  bps: commission.bps,
                  amountMinor: commission.amountMinor,
                },
                updatedAt: now,
              },
            },
          },
        });
      }
      if (found !== ids.length) {
        throw new AppError(
          409,
          "INVALID_APPOINTMENTS",
          "Only completed appointments of this barber can be paid",
        );
      }
      const payout = {
        _id: payoutId,
        tenantId: barber.tenantId,
        barberId: barber._id,
        currency: tenant.currency,
        amountMinor,
        appointmentIds: ids,
        ...(input.reference && { reference: input.reference }),
        paidAt: input.paidAt ?? now,
        createdBy: staffId,
        createdAt: now,
      };
      // The unique index on appointmentIds rejects a second payout for the same appointment.
      await platform.payouts.insertOne(payout, { session });
      await platform.appointments.bulkWrite(marks, { session, ordered: false });
      return {
        id: payout._id.toHexString(),
        amountMinor,
        currency: payout.currency,
        appointments: ids.length,
        paidAt: payout.paidAt.toISOString(),
      };
    });
  } catch (err) {
    if (isDuplicate(err)) {
      throw new AppError(
        409,
        "ALREADY_PAID",
        "An appointment was already paid",
      );
    }
    throw err;
  }
}
