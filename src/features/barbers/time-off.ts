import { type Filter, ObjectId, type WithId } from "mongodb";
import type * as z from "zod";
import {
  type AppointmentDoc,
  type BarberDoc,
  type BranchDoc,
  forTenant,
  type TimeOffDoc,
  transaction,
} from "../../db/scoped";
import { collect, mapBy } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { instantToLocal, localToInstant } from "../../shared/time";
import { visibleBranchIds } from "../auth/policy";
import { getBranch } from "../tenancy/service";
import type { timeOffCreate } from "./schemas";
import { getBarber, ownBarberId } from "./service";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

async function assertCanManage(auth: Auth, barberId?: ObjectId) {
  if (auth.role !== "barber") return;
  const own = await ownBarberId(auth);
  if (!barberId || !own?.equals(barberId)) {
    throw new AppError(403, "FORBIDDEN", "Not allowed");
  }
}

export async function createTimeOff(
  auth: Auth,
  input: z.output<typeof timeOffCreate>,
) {
  const barber = input.barberId
    ? await getBarber(auth, input.barberId)
    : undefined;
  const branchId = barber?.branchId ?? input.branchId;
  if (!branchId) throw notFound();
  const [branch] = await Promise.all([
    getBranch(auth, branchId),
    assertCanManage(auth, barber?._id),
  ]);
  const entry: TimeOffDoc = {
    _id: new ObjectId(),
    tenantId: auth.tenantId,
    branchId: branch._id,
    barberId: barber?._id,
    startAt: localToInstant(input.start, branch.timeZone),
    endAt: localToInstant(input.end, branch.timeZone),
    kind: input.kind,
    reason: input.reason,
    createdBy: auth.userId,
    createdAt: new Date(),
  };
  if (entry.endAt <= entry.startAt) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "end", message: "must be after start" },
    ]);
  }
  const t = forTenant(auth.tenantId);
  await transaction(async (session) => {
    // Bump each barber's lock as it is read: no list of ids is held.
    if (barber) {
      await t.barbers.updateOne(
        { _id: barber._id },
        { $inc: { lockVersion: 1 } },
        { session },
      );
    } else {
      const ids = t.barbers
        .find({ branchId: branch._id }, { session })
        .project<Pick<BarberDoc, "_id">>({ _id: 1 });
      for await (const { _id } of ids) {
        await t.barbers.updateOne(
          { _id },
          { $inc: { lockVersion: 1 } },
          { session },
        );
      }
    }
    const clashes = await collect(
      t.appointments
        .find(
          {
            branchId: branch._id,
            status: "confirmed",
            startAt: { $lt: entry.endAt },
            endAt: { $gt: entry.startAt },
            ...(barber && { barberId: barber._id }),
          },
          { session, limit: 20 },
        )
        .project<WithId<Pick<AppointmentDoc, "startAt">>>({ startAt: 1 }),
    );
    if (clashes.length > 0) {
      throw new AppError(
        409,
        "APPOINTMENTS_IN_THE_WAY",
        "Move or cancel these appointments first",
        clashes.map((a) => ({
          path: `appointments.${a._id.toHexString()}`,
          message: instantToLocal(a.startAt, branch.timeZone),
        })),
      );
    }
    await t.timeOff.insertOne(entry, { session });
  });
  return toTimeOff(entry, branch.timeZone);
}

export async function listTimeOff(
  auth: Auth,
  query: { branchId?: ObjectId; barberId?: ObjectId },
  now = new Date(),
) {
  const t = forTenant(auth.tenantId);
  const ids = visibleBranchIds(auth);
  const clauses: Filter<TimeOffDoc>[] = [{ endAt: { $gt: now } }];
  if (ids) clauses.push({ branchId: { $in: ids } });
  if (query.branchId) clauses.push({ branchId: query.branchId });
  if (query.barberId) clauses.push({ barberId: query.barberId });
  if (auth.role === "barber") {
    const own = await ownBarberId(auth);
    clauses.push({
      $or: [
        { barberId: { $in: own ? [own] : [] } },
        { barberId: { $exists: false } },
      ],
    });
  }
  const entries = await collect(
    t.timeOff.find({ $and: clauses }).sort({ startAt: 1 }).limit(500),
  );
  const zoneOf = await mapBy(
    t.branches
      .find({ _id: { $in: [...new Set(entries.map((e) => e.branchId))] } })
      .project<WithId<Pick<BranchDoc, "timeZone">>>({ timeZone: 1 }),
    (b) => b._id.toHexString(),
    (b) => b.timeZone,
  );
  return entries.map((e) =>
    toTimeOff(e, zoneOf.get(e.branchId.toHexString()) ?? "UTC"),
  );
}

export async function deleteTimeOff(auth: Auth, id: ObjectId) {
  const t = forTenant(auth.tenantId);
  const ids = visibleBranchIds(auth);
  const entry = await t.timeOff.findOne({
    $and: [{ _id: id }, ids ? { branchId: { $in: ids } } : {}],
  });
  if (!entry) throw notFound();
  await assertCanManage(auth, entry.barberId);
  await t.timeOff.deleteOne({ _id: id });
}

const toTimeOff = (e: TimeOffDoc, timeZone: string) => ({
  id: e._id.toHexString(),
  branchId: e.branchId.toHexString(),
  ...(e.barberId && { barberId: e.barberId.toHexString() }),
  kind: e.kind,
  reason: e.reason,
  startAt: e.startAt,
  endAt: e.endAt,
  start: instantToLocal(e.startAt, timeZone),
  end: instantToLocal(e.endAt, timeZone),
  timeZone,
});
