import { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  type BranchDoc,
  forTenant,
  type LedgerEntryDoc,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { collect, mapBy } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { localDate } from "../../shared/time";
import { visibleBranchIds } from "../auth/policy";
import { dueAtCounter } from "../booking/counter";
import { tally } from "../money/rules";
import { inMinor, type Movement, summarize } from "./rules";

const DAY = 864e5;
const MAX_ENTRIES = 2_000;
const hex = (id: ObjectId) => id.toHexString();

type Cut = Pick<
  AppointmentDoc,
  "_id" | "timeZone" | "startAt" | "totalMinor" | "payment" | "counter"
>;

export async function cashDay(
  tenant: Pick<TenantDoc, "_id" | "currency">,
  auth: Auth,
  date: string,
  branchId?: ObjectId,
) {
  const visible = visibleBranchIds(auth);
  if (branchId && visible && !visible.some((id) => id.equals(branchId))) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  const branchIds = branchId ? [branchId] : visible;
  const inBranches = branchIds ? { branchId: { $in: branchIds } } : {};
  const t = forTenant(tenant._id);

  const entries = await collect(
    t.ledgerEntries
      .find({ ...inBranches, currency: tenant.currency, localDate: date })
      .sort({ at: 1, _id: 1 })
      .limit(MAX_ENTRIES),
  );
  const zones = await mapBy(
    t.branches
      .find(branchIds ? { _id: { $in: branchIds } } : {})
      .project<Pick<BranchDoc, "_id" | "timeZone">>({ timeZone: 1 }),
    (b) => hex(b._id),
    (b) => b.timeZone,
  );
  const zoneOf = (id: ObjectId) => zones.get(hex(id)) ?? "UTC";

  const start = Date.parse(`${date}T00:00:00Z`);
  const pending = { count: 0, amountMinor: 0 };
  const cuts = t.appointments
    .find({
      ...inBranches,
      status: "completed",
      counter: { $exists: false },
      startAt: { $gte: new Date(start - DAY), $lt: new Date(start + 2 * DAY) },
    })
    .project<Cut>({
      timeZone: 1,
      startAt: 1,
      totalMinor: 1,
      payment: 1,
      counter: 1,
    });
  for await (const a of cuts) {
    const due = dueAtCounter(a);
    if (due > 0 && localDate(a.startAt, a.timeZone) === date) {
      pending.count++;
      pending.amountMinor += due;
    }
  }

  const visitIds = entries.flatMap((e) =>
    e.appointmentId ? [e.appointmentId] : [],
  );
  const visits = await mapBy(
    t.appointments
      .find({ _id: { $in: visitIds } })
      .project<Pick<AppointmentDoc, "_id" | "startAt">>({ startAt: 1 }),
    (a) => hex(a._id),
    (a) => a.startAt,
  );
  const people = [
    ...new Set(
      entries.flatMap((e) =>
        [e.customerId, e.recordedBy].flatMap((id) => (id ? [hex(id)] : [])),
      ),
    ),
  ].map((id) => new ObjectId(id));
  const names = await mapBy(
    t.users
      .find({ _id: { $in: people } })
      .project<Pick<UserDoc, "_id" | "name">>({ name: 1 }),
    (u) => hex(u._id),
    (u) => u.name,
  );
  const nameOf = (id?: ObjectId) => (id ? (names.get(hex(id)) ?? "") : "");
  const reversed = new Set(
    await collect(
      t.ledgerEntries
        .find({ reverses: { $in: entries.map((e) => e._id) } })
        .project<Pick<LedgerEntryDoc, "_id" | "reverses">>({ reverses: 1 }),
      (e) => (e.reverses ? hex(e.reverses) : ""),
    ),
  );

  const totals = tally([], "day");
  const legacy: Movement[] = [];
  for (const e of entries) {
    totals.push(e);
    if (e.direction === "in" && e.method && e.recordedBy) {
      legacy.push({
        kind: e.type === "product_sale" ? "product" : "cut",
        source: e.channel === "spei" ? "transfer" : "counter",
        method: e.method,
        amountMinor: e.amountMinor,
        receivedBy: hex(e.recordedBy),
        customerId: e.customerId ? hex(e.customerId) : "",
        at: e.at,
        timeZone: zoneOf(e.branchId),
        ...(e.reference && { reference: e.reference }),
        ...(e.channel === "spei" &&
          e.appointmentId && { visitAt: visits.get(hex(e.appointmentId)) }),
      });
    }
  }
  const { inMinor: inTotal, outMinor, netMinor, byMethod } = totals.result();
  const collected = summarize(legacy);

  return {
    currency: tenant.currency,
    date,
    inMinor: inTotal,
    outMinor,
    netMinor,
    byMethod,
    pending,
    entries: entries.map((e) => {
      const visitAt = e.appointmentId
        ? visits.get(hex(e.appointmentId))
        : undefined;
      return {
        id: hex(e._id),
        at: e.at,
        timeZone: zoneOf(e.branchId),
        direction: e.direction,
        type: e.type,
        amountMinor: e.amountMinor,
        concept: e.concept,
        ...(e.method && { method: e.method }),
        ...(e.channel && { channel: e.channel }),
        ...(e.customerId && { customer: nameOf(e.customerId) }),
        ...(e.recordedBy && { recordedBy: nameOf(e.recordedBy) }),
        ...(e.reference && { reference: e.reference }),
        ...(e.appointmentId && { appointmentId: hex(e.appointmentId) }),
        ...(visitAt && { visitAt }),
        ...(e.productOrderId && { productOrderId: hex(e.productOrderId) }),
        ...(e.payoutId && { payoutId: hex(e.payoutId) }),
        ...(e.paymentId && { paymentId: hex(e.paymentId) }),
        ...(e.reverses && { reverses: hex(e.reverses) }),
        ...(reversed.has(hex(e._id)) && { reversed: true }),
        ...(e.note && { note: e.note }),
        ...(e.approximate && { approximate: true }),
      };
    }),
    totals: inMinor(collected.totals),
    people: [...collected.people].map(([id, sums]) => ({
      id,
      name: names.get(id) ?? "",
      ...inMinor(sums),
    })),
    movements: legacy.map((m) => ({
      kind: m.kind,
      source: m.source,
      method: m.method,
      amountMinor: m.amountMinor,
      at: m.at,
      timeZone: m.timeZone,
      receivedBy: names.get(m.receivedBy) ?? "",
      customer: names.get(m.customerId) ?? "",
      ...(m.reference && { reference: m.reference }),
      ...(m.visitAt && { visitAt: m.visitAt }),
    })),
    unrecorded: pending.count,
  };
}
