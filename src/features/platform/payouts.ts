import { type AnyBulkWriteOperation, ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  type BarberDoc,
  type BranchDoc,
  platform,
  transaction,
} from "../../db/scoped";
import { collect, mapBy } from "../../shared/cursor";
import { AppError, isDuplicate } from "../../shared/http";
import { localDate } from "../../shared/time";
import { payoutEntry } from "../money/rules";
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
      const branch = await platform.branches.findOne(
        { _id: barber.branchId, tenantId: barber.tenantId },
        { session, projection: { timeZone: 1 } },
      );
      const entry = payoutEntry(payout, barber, branch?.timeZone ?? "UTC");
      if (entry) {
        await platform.ledgerEntries.insertOne(
          { ...entry, tenantId: barber.tenantId },
          { session },
        );
      }
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

const DAY_MS = 864e5;

/**
 * The barbershop's payouts made on the local days `from`–`to` (the barber's branch zone), newest
 * first: who, how much, how many cuts and the reference. A shop records few, so a bounded read is enough.
 */
export async function listPayouts(
  tenantId: ObjectId,
  from: string,
  to: string,
) {
  // A day of slack on each side in UTC, then the exact local day of each payout decides.
  const start = new Date(Date.parse(`${from}T00:00:00Z`) - DAY_MS);
  const end = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS);
  const payouts = await collect(
    platform.payouts
      .find({ tenantId, paidAt: { $gte: start, $lt: end } })
      .sort({ paidAt: -1 })
      .limit(500),
  );
  const barberIds = [...new Set(payouts.map((p) => p.barberId.toHexString()))];
  const barbers = await mapBy(
    platform.barbers
      .find({
        tenantId,
        _id: { $in: barberIds.map((id) => new ObjectId(id)) },
      })
      .project<Pick<BarberDoc, "_id" | "name" | "branchId">>({
        name: 1,
        branchId: 1,
      }),
    (b) => b._id.toHexString(),
  );
  const branchIds = [
    ...new Set([...barbers.values()].map((b) => b.branchId.toHexString())),
  ];
  const branches = await mapBy(
    platform.branches
      .find({
        tenantId,
        _id: { $in: branchIds.map((id) => new ObjectId(id)) },
      })
      .project<Pick<BranchDoc, "_id" | "name" | "timeZone">>({
        name: 1,
        timeZone: 1,
      }),
    (b) => b._id.toHexString(),
  );
  return payouts.flatMap((p) => {
    const barber = barbers.get(p.barberId.toHexString());
    const branch = barber && branches.get(barber.branchId.toHexString());
    const day = localDate(p.paidAt, branch?.timeZone ?? "UTC");
    if (day < from || day > to) return [];
    return [
      {
        id: p._id.toHexString(),
        barberId: p.barberId.toHexString(),
        barberName: barber?.name ?? "",
        branchName: branch?.name ?? "",
        currency: p.currency,
        amountMinor: p.amountMinor,
        appointments: p.appointmentIds.length,
        ...(p.reference && { reference: p.reference }),
        paidAt: p.paidAt.toISOString(),
      },
    ];
  });
}
