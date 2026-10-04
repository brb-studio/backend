import { type Filter, ObjectId } from "mongodb";
import type * as z from "zod";
import { forTenant, type TimeOffDoc, transaction } from "../../db/scoped";
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
    const locked = barber
      ? [barber._id]
      : (
          await t.barbers
            .find({ branchId: branch._id }, { session, projection: { _id: 1 } })
            .toArray()
        ).map((b) => b._id);
    for (const id of locked) {
      await t.barbers.updateOne(
        { _id: id },
        { $inc: { lockVersion: 1 } },
        { session },
      );
    }
    const clashes = await t.appointments
      .find(
        {
          branchId: branch._id,
          status: "confirmed",
          startAt: { $lt: entry.endAt },
          endAt: { $gt: entry.startAt },
          ...(barber && { barberId: barber._id }),
        },
        { session, limit: 20, projection: { startAt: 1 } },
      )
      .toArray();
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
  const entries = await t.timeOff
    .find({ $and: clauses })
    .sort({ startAt: 1 })
    .limit(500)
    .toArray();
  const branches = await t.branches
    .find({ _id: { $in: [...new Set(entries.map((e) => e.branchId))] } })
    .toArray();
  const zoneOf = new Map(
    branches.map((b) => [b._id.toHexString(), b.timeZone]),
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
