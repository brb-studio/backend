import { ObjectId } from "mongodb";
import type * as z from "zod";
import { forTenant, type TenantDoc, type WaitlistDoc } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { startOfDay } from "../availability/engine";
import { bookableDates, openSlots } from "../availability/service";
import { canServe } from "../catalog/rules";
import { resolveRequest } from "../catalog/service";
import { inWindow, MAX_ACTIVE } from "./rules";
import type { joinBody } from "./schemas";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

export async function joinWaitlist(
  tenant: TenantDoc,
  auth: Auth,
  input: z.output<typeof joinBody>,
) {
  const t = forTenant(tenant._id);
  const [branch, request] = await Promise.all([
    t.branches.findOne({ slug: input.branch, active: true }),
    resolveRequest(tenant._id, input),
  ]);
  if (!branch) throw notFound();
  const barber = input.barber
    ? await t.barbers.findOne({
        slug: input.barber,
        branchId: branch._id,
        active: true,
      })
    : undefined;
  if (input.barber && (!barber || !canServe(barber, request))) throw notFound();

  const now = Date.now();
  const { dates } = bookableDates(
    branch.timeZone,
    now,
    branch.booking.windowDays,
    { from: input.date, days: 1 },
  );
  if (dates[0] !== input.date) {
    throw new AppError(422, "VALIDATION", "That day can't be booked yet");
  }

  const times = await openSlots(tenant, branch, request, {
    date: input.date,
    barberId: barber?._id,
  });
  if (times.some((time) => inWindow(time, input.from, input.to))) {
    throw new AppError(409, "SLOTS_AVAILABLE", "There are times to book");
  }

  const active = await collect(
    t.waitlist
      .find({ customerId: auth.userId })
      .project<
        Pick<WaitlistDoc, "_id" | "branchId" | "item" | "barberId" | "date">
      >({ branchId: 1, item: 1, barberId: 1, date: 1 })
      .limit(MAX_ACTIVE + 1),
  );
  if (active.length >= MAX_ACTIVE) {
    throw new AppError(409, "WAITLIST_FULL", "Too many entries waiting");
  }
  const [service] = request.services;
  const item: WaitlistDoc["item"] | undefined = request.pkg
    ? { kind: "package", slug: request.pkg.slug, name: request.pkg.name }
    : service && { kind: "service", slug: service.slug, name: service.name };
  if (!item) throw notFound();
  const duplicate = active.some(
    (e) =>
      e.branchId.equals(branch._id) &&
      e.date === input.date &&
      e.item.slug === item.slug &&
      (e.barberId?.toHexString() ?? "") === (barber?._id.toHexString() ?? ""),
  );
  if (duplicate) throw new AppError(409, "ALREADY_WAITING", "Already waiting");

  const entry: Omit<WaitlistDoc, "tenantId"> = {
    _id: new ObjectId(),
    customerId: auth.userId,
    branchId: branch._id,
    item,
    ...(barber && { barberId: barber._id }),
    date: input.date,
    ...(input.from && { from: input.from }),
    ...(input.to && { to: input.to }),
    status: "waiting",
    expiresAt: new Date(
      startOfDay(
        Temporal.PlainDate.from(input.date).add({ days: 1 }).toString(),
        branch.timeZone,
      ),
    ),
    createdAt: new Date(),
  };
  await t.waitlist.insertOne(entry);
  return { id: entry._id.toHexString() };
}

export async function listMyWaitlist(tenant: TenantDoc, auth: Auth) {
  const t = forTenant(tenant._id);
  const entries = await collect(
    t.waitlist.find({ customerId: auth.userId }).sort({ date: 1 }).limit(20),
  );
  const branches = new Map<string, { slug: string; name: string }>();
  for (const e of entries) {
    const key = e.branchId.toHexString();
    if (branches.has(key)) continue;
    const branch = await t.branches.findOne(
      { _id: e.branchId },
      { projection: { slug: 1, name: 1 } },
    );
    if (branch) branches.set(key, { slug: branch.slug, name: branch.name });
  }
  return entries.flatMap((e) => {
    const branch = branches.get(e.branchId.toHexString());
    if (!branch) return [];
    return [
      {
        id: e._id.toHexString(),
        branch,
        item: e.item,
        date: e.date,
        from: e.from,
        to: e.to,
        status: e.status,
      },
    ];
  });
}

export async function leaveWaitlist(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
) {
  const { deletedCount } = await forTenant(tenant._id).waitlist.deleteOne({
    _id: id,
    customerId: auth.userId,
  });
  if (deletedCount === 0) throw notFound();
}
