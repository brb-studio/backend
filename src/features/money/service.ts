import { ObjectId } from "mongodb";
import type * as z from "zod";
import {
  type BranchDoc,
  forTenant,
  type LedgerEntryDoc,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { collect, mapBy } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { visibleBranchIds } from "../auth/policy";
import { periodsBetween, previousRange, tally } from "./rules";
import type { movementsQuery, summaryQuery } from "./schemas";

type Tenant = Pick<TenantDoc, "_id" | "currency">;

function scopeOf(
  tenant: Tenant,
  auth: Auth,
  from: string,
  to: string,
  branchId?: ObjectId,
) {
  const visible = visibleBranchIds(auth);
  if (branchId && visible && !visible.some((id) => id.equals(branchId))) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  const branchIds = branchId ? [branchId] : visible;
  return {
    currency: tenant.currency,
    localDate: { $gte: from, $lte: to },
    ...(branchIds && { branchId: { $in: branchIds } }),
  };
}

type Row = Pick<
  LedgerEntryDoc,
  "localDate" | "direction" | "type" | "method" | "amountMinor"
>;
const ROW = {
  _id: 0,
  localDate: 1,
  direction: 1,
  type: 1,
  method: 1,
  amountMinor: 1,
};

export async function moneySummary(
  tenant: Tenant,
  auth: Auth,
  query: z.output<typeof summaryQuery>,
) {
  const { from, to, groupBy, branchId } = query;
  const t = forTenant(tenant._id);
  const sum = async (
    range: { from: string; to: string },
    periods: string[],
  ) => {
    const totals = tally(periods, groupBy);
    const rows = t.ledgerEntries
      .find(scopeOf(tenant, auth, range.from, range.to, branchId))
      .project<Row>(ROW);
    for await (const row of rows) totals.push(row);
    return totals.result();
  };
  const current = await sum({ from, to }, periodsBetween(from, to, groupBy));
  const before = previousRange(from, to);
  const { inMinor, outMinor, netMinor } = await sum(before, []);
  return {
    currency: tenant.currency,
    from,
    to,
    groupBy,
    ...current,
    previous: { ...before, inMinor, outMinor, netMinor },
  };
}

const hex = (id: ObjectId) => id.toHexString();

export async function moneyMovements(
  tenant: Tenant,
  auth: Auth,
  query: z.output<typeof movementsQuery>,
) {
  const { from, to, branchId, direction, type, method, page, pageSize } = query;
  const t = forTenant(tenant._id);
  const filter = {
    ...scopeOf(tenant, auth, from, to, branchId),
    ...(direction && { direction }),
    ...(type && { type }),
    ...(method && { method }),
  };
  const [total, entries] = await Promise.all([
    t.ledgerEntries.countDocuments(filter),
    collect(
      t.ledgerEntries
        .find(filter)
        .sort({ localDate: -1, at: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
    ),
  ]);
  const ids = [
    ...new Set(
      entries.flatMap((e) =>
        [e.customerId, e.recordedBy].filter((id) => id !== undefined).map(hex),
      ),
    ),
  ].map((id) => new ObjectId(id));
  const names = await mapBy(
    t.users
      .find({ _id: { $in: ids } })
      .project<Pick<UserDoc, "_id" | "name">>({ name: 1 }),
    (u) => hex(u._id),
    (u) => u.name,
  );
  const nameOf = (id?: ObjectId) => (id ? names.get(hex(id)) : undefined);
  const zones = await mapBy(
    t.branches
      .find({ _id: { $in: [...new Set(entries.map((e) => e.branchId))] } })
      .project<Pick<BranchDoc, "_id" | "timeZone">>({ timeZone: 1 }),
    (b) => hex(b._id),
    (b) => b.timeZone,
  );
  return {
    currency: tenant.currency,
    page,
    pageSize,
    total,
    rows: entries.map((e) => ({
      id: hex(e._id),
      at: e.at,
      localDate: e.localDate,
      timeZone: zones.get(hex(e.branchId)) ?? "UTC",
      branchId: hex(e.branchId),
      direction: e.direction,
      type: e.type,
      amountMinor: e.amountMinor,
      concept: e.concept,
      ...(e.method && { method: e.method }),
      ...(e.channel && { channel: e.channel }),
      ...(e.customerId && { customer: nameOf(e.customerId) ?? "" }),
      ...(e.recordedBy && { recordedBy: nameOf(e.recordedBy) ?? "" }),
      ...(e.reference && { reference: e.reference }),
      ...(e.appointmentId && { appointmentId: hex(e.appointmentId) }),
      ...(e.productOrderId && { productOrderId: hex(e.productOrderId) }),
      ...(e.payoutId && { payoutId: hex(e.payoutId) }),
      ...(e.reverses && { reverses: hex(e.reverses) }),
      ...(e.note && { note: e.note }),
      ...(e.approximate && { approximate: true }),
    })),
  };
}
