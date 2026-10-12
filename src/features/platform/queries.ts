import type { Filter, ObjectId, WithId } from "mongodb";
import {
  type AppointmentDoc,
  type BarberDoc,
  type BranchDoc,
  type PayoutDoc,
  platform,
  type TenantDoc,
} from "../../db/scoped";
import { collect, mapBy } from "../../shared/cursor";
import { AppError } from "../../shared/http";
import { resolveCommission } from "./commission";
import type { Filters } from "./schemas";

const DAY = 864e5;
const dayMs = (value: string) => Date.parse(`${value}T00:00:00Z`);
export const hex = (id: ObjectId) => id.toHexString();

const zones = new Map<string, Intl.DateTimeFormat>();

/** The appointment's own calendar day ("2025-03-10") in its branch's time zone. */
function localDate(at: Date, timeZone: string) {
  let format = zones.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
    }
    zones.set(timeZone, format);
  }
  return format.format(at);
}

const scope = (f: Filters): Filter<AppointmentDoc> => ({
  startAt: {
    $gte: new Date(dayMs(f.from) - DAY),
    $lt: new Date(dayMs(f.to) + 2 * DAY),
  },
  ...(f.tenantId && { tenantId: f.tenantId }),
  ...(f.branchId && { branchId: f.branchId }),
  ...(f.barberId && { barberId: f.barberId }),
  ...(f.status && { status: f.status }),
});

const inPeriod = (f: Filters, a: { startAt: Date; timeZone: string }) => {
  const day = localDate(a.startAt, a.timeZone);
  return day >= f.from && day <= f.to;
};

type Row = Pick<
  AppointmentDoc,
  | "_id"
  | "tenantId"
  | "branchId"
  | "barberId"
  | "status"
  | "startAt"
  | "timeZone"
  | "currency"
  | "totalMinor"
  | "payment"
  | "commission"
  | "payoutId"
>;

const REPORT_FIELDS = {
  tenantId: 1,
  branchId: 1,
  barberId: 1,
  status: 1,
  startAt: 1,
  timeZone: 1,
  currency: 1,
  totalMinor: 1,
  "payment.status": 1,
  "payment.amountMinor": 1,
  commission: 1,
  payoutId: 1,
};

async function rateMap(f: Filters) {
  const rates = new Map<string, number>();
  const cursor = platform.barbers
    .find({
      commissionBps: { $exists: true },
      ...(f.tenantId && { tenantId: f.tenantId }),
      ...(f.branchId && { branchId: f.branchId }),
      ...(f.barberId && { _id: f.barberId }),
    })
    .project<Required<WithId<Pick<BarberDoc, "commissionBps">>>>({
      commissionBps: 1,
    });
  for await (const barber of cursor)
    rates.set(hex(barber._id), barber.commissionBps);
  return rates;
}

type Totals = {
  completed: number;
  confirmed: number;
  cancelled: number;
  noShow: number;
  sales: number;
  collected: number;
  commission: number;
  paidOut: number;
  unconfigured: number;
  lastAt?: Date;
};

const emptyTotals = (): Totals => ({
  completed: 0,
  confirmed: 0,
  cancelled: 0,
  noShow: 0,
  sales: 0,
  collected: 0,
  commission: 0,
  paidOut: 0,
  unconfigured: 0,
});

const finish = ({ lastAt, ...m }: Totals) => ({
  ...m,
  pending: m.commission - m.paidOut,
  avgTicket: m.completed ? Math.round(m.sales / m.completed) : 0,
  lastAt: lastAt?.toISOString() ?? null,
});

function add(totals: Totals, a: Row, rates: Map<string, number>) {
  if (a.status === "completed") {
    totals.completed++;
    totals.sales += a.totalMinor;
    const c = resolveCommission(a, rates.get(hex(a.barberId)));
    if (c) {
      totals.commission += c.amountMinor;
      if (a.payoutId) totals.paidOut += c.amountMinor;
    } else {
      totals.unconfigured++;
    }
  } else if (a.status === "confirmed") totals.confirmed++;
  else if (a.status === "cancelled") totals.cancelled++;
  else if (a.status === "no_show") totals.noShow++;
  // `pending_payment` (an online booking not paid yet) is neither a cut nor a no-show.
  if (a.payment?.status === "paid") totals.collected += a.payment.amountMinor;
  if (!totals.lastAt || a.startAt > totals.lastAt) totals.lastAt = a.startAt;
}

async function totalsBy(f: Filters, keyOf: (a: Row) => string) {
  const rates = await rateMap(f);
  const groups = new Map<string, Totals>();
  const cursor = platform.appointments
    .find(scope(f))
    .project<Row>(REPORT_FIELDS);
  for await (const a of cursor) {
    if (!inPeriod(f, a)) continue;
    const key = keyOf(a);
    let totals = groups.get(key);
    if (!totals) {
      totals = emptyTotals();
      groups.set(key, totals);
    }
    add(totals, a, rates);
  }
  return groups;
}

/** Totals for the period, one entry per currency: money in different currencies is never added up. */
export async function summary(f: Filters) {
  const groups = await totalsBy(f, (a) => a.currency);
  return [...groups]
    .map(([currency, totals]) => ({ currency, ...finish(totals) }))
    .sort((a, b) => b.sales - a.sales);
}

const idOf = (doc: { _id: ObjectId }) => hex(doc._id);

type Entity = WithId<Pick<BarberDoc, "name" | "tenantId" | "active">> &
  Partial<Pick<BarberDoc, "branchId" | "commissionBps">>;

/** Active children per parent, counted in Mongo instead of streaming every document. */
async function countActive(
  col: typeof platform.barbers | typeof platform.branches,
  key: "tenantId" | "branchId",
  ids: ObjectId[],
) {
  const rows = await col
    .aggregate<{ _id: ObjectId; n: number }>([
      { $match: { active: true, [key]: { $in: ids } } },
      { $group: { _id: `$${key}`, n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [hex(r._id), r.n]));
}

export async function breakdown(
  by: "tenant" | "branch" | "barber",
  f: Filters,
  { page, limit }: { page: number; limit: number },
) {
  const field = {
    tenant: "tenantId",
    branch: "branchId",
    barber: "barberId",
  } as const;
  const numbers = await totalsBy(f, (a) => hex(a[field[by]]));
  const tenantScope = f.tenantId ? { tenantId: f.tenantId } : {};
  const entities: Entity[] =
    by === "tenant"
      ? await collect(
          platform.tenants
            .find(f.tenantId ? { _id: f.tenantId } : {})
            .project<WithId<Pick<TenantDoc, "name">>>({ name: 1 })
            .limit(2000),
          (t) => ({ ...t, tenantId: t._id, active: true }),
        )
      : by === "branch"
        ? await collect(
            platform.branches
              .find({ ...tenantScope, ...(f.branchId && { _id: f.branchId }) })
              .project<Entity>({ name: 1, tenantId: 1, active: 1 })
              .limit(2000),
          )
        : await collect(
            platform.barbers
              .find({
                ...tenantScope,
                ...(f.branchId && { branchId: f.branchId }),
                ...(f.barberId && { _id: f.barberId }),
              })
              .project<Entity>({
                name: 1,
                tenantId: 1,
                branchId: 1,
                active: 1,
                commissionBps: 1,
              })
              .limit(2000),
          );

  const ranked = entities
    .map((e) => ({ e, m: numbers.get(hex(e._id)) ?? emptyTotals() }))
    .sort((a, b) => b.m.sales - a.m.sales || a.e.name.localeCompare(b.e.name));
  const pageRows = ranked.slice((page - 1) * limit, page * limit);
  const ids = pageRows.map(({ e }) => e._id);
  const tenantIds = pageRows.map(({ e }) => e.tenantId);

  const branchIds = pageRows.flatMap(({ e }) => e.branchId ?? []);
  const none = <T>() => new Map<string, T>();

  const [tenantOf, branchOf, barbersOf, branchesOf] = await Promise.all([
    mapBy(
      platform.tenants
        .find({ _id: { $in: tenantIds } })
        .project<WithId<Pick<TenantDoc, "name" | "currency">>>({
          name: 1,
          currency: 1,
        }),
      idOf,
    ),
    by === "barber"
      ? mapBy(
          platform.branches
            .find({ _id: { $in: branchIds } })
            .project<WithId<Pick<BranchDoc, "name">>>({ name: 1 }),
          idOf,
        )
      : none<WithId<Pick<BranchDoc, "name">>>(),
    by === "barber"
      ? none<number>()
      : countActive(
          platform.barbers,
          by === "tenant" ? "tenantId" : "branchId",
          ids,
        ),
    by === "tenant"
      ? countActive(platform.branches, "tenantId", ids)
      : none<number>(),
  ]);

  return {
    total: ranked.length,
    rows: pageRows.map(({ e, m }) => {
      const tenant = tenantOf.get(hex(e.tenantId));
      return {
        id: hex(e._id),
        name: e.name,
        currency: tenant?.currency ?? "",
        ...(by !== "tenant" && {
          tenantId: hex(e.tenantId),
          tenantName: tenant?.name ?? "",
          active: e.active,
        }),
        ...(by === "tenant" && {
          activeBranches: branchesOf.get(hex(e._id)) ?? 0,
          activeBarbers: barbersOf.get(hex(e._id)) ?? 0,
        }),
        ...(by === "branch" && {
          activeBarbers: barbersOf.get(hex(e._id)) ?? 0,
        }),
        ...(by === "barber" &&
          e.branchId && {
            branchId: hex(e.branchId),
            branchName: branchOf.get(hex(e.branchId))?.name ?? "",
            commissionBps: e.commissionBps ?? null,
          }),
        ...finish(m),
      };
    }),
  };
}

type Barber = WithId<Pick<BarberDoc, "name" | "commissionBps">>;

/** Names (and each barber's current rate) for the rows of one page: three batched reads, never one per row. */
async function names(
  list: { tenantId: ObjectId; branchId: ObjectId; barberId: ObjectId }[],
) {
  const ids = (pick: "tenantId" | "branchId" | "barberId") => [
    ...new Map(list.map((a) => [hex(a[pick]), a[pick]])).values(),
  ];
  const [tenantOf, branchOf, barberOf] = await Promise.all([
    mapBy(
      platform.tenants
        .find({ _id: { $in: ids("tenantId") } })
        .project<WithId<Pick<TenantDoc, "name" | "currency">>>({
          name: 1,
          currency: 1,
        }),
      idOf,
    ),
    mapBy(
      platform.branches
        .find({ _id: { $in: ids("branchId") } })
        .project<WithId<Pick<BranchDoc, "name" | "timeZone">>>({
          name: 1,
          timeZone: 1,
        }),
      idOf,
    ),
    mapBy(
      platform.barbers
        .find({ _id: { $in: ids("barberId") } })
        .project<Barber>({ name: 1, commissionBps: 1 }),
      idOf,
    ),
  ]);
  return { tenantOf, branchOf, barberOf };
}

type Barbers = (id: ObjectId) => { commissionBps?: number } | undefined;

/** The commission as the dashboard shows it, including why there may be none. */
const commissionView = (a: AppointmentDoc, barberOf: Barbers) => {
  if (a.status !== "completed") return { state: "not_applicable" as const };
  const c = resolveCommission(a, barberOf(a.barberId)?.commissionBps);
  if (!c) return { state: "unconfigured" as const };
  return {
    state: a.payoutId ? ("paid" as const) : ("accrued" as const),
    bps: c.bps,
    baseMinor: a.totalMinor,
    amountMinor: c.amountMinor,
    source: c.source,
  };
};

export async function listAppointments(
  f: Filters,
  { page, limit }: { page: number; limit: number },
) {
  const matches: { at: number; id: ObjectId }[] = [];
  const cursor = platform.appointments
    .find(scope(f))
    .project<WithId<Pick<AppointmentDoc, "startAt" | "timeZone">>>({
      startAt: 1,
      timeZone: 1,
    });
  for await (const a of cursor) {
    if (inPeriod(f, a)) matches.push({ at: a.startAt.getTime(), id: a._id });
  }
  matches.sort((a, b) => b.at - a.at || hex(b.id).localeCompare(hex(a.id)));
  const window = matches.slice((page - 1) * limit, page * limit);
  if (window.length === 0) return { total: matches.length, rows: [] };

  const rows = await mapBy(
    platform.appointments.find({ _id: { $in: window.map((m) => m.id) } }),
    idOf,
  );
  const docs = [...rows.values()];
  const paid = new Map<string, Date>();
  const payoutIds = docs.flatMap((d) => d.payoutId ?? []);
  if (payoutIds.length > 0) {
    const payouts = platform.payouts
      .find({ _id: { $in: payoutIds } })
      .project<WithId<Pick<PayoutDoc, "paidAt">>>({ paidAt: 1 });
    for await (const payout of payouts)
      paid.set(hex(payout._id), payout.paidAt);
  }
  const { tenantOf, branchOf, barberOf } = await names(docs);
  const list: ReturnType<typeof rowOf>[] = [];
  const rowOf = (a: AppointmentDoc) => {
    const paidAt = a.payoutId && paid.get(hex(a.payoutId));
    return {
      id: hex(a._id),
      startAt: a.startAt.toISOString(),
      timeZone: a.timeZone,
      status: a.status,
      tenantId: hex(a.tenantId),
      tenantName: tenantOf.get(hex(a.tenantId))?.name ?? "",
      branchId: hex(a.branchId),
      branchName: branchOf.get(hex(a.branchId))?.name ?? "",
      barberId: hex(a.barberId),
      barberName: barberOf.get(hex(a.barberId))?.name ?? "",
      items: a.items.map((i) => ({ kind: i.kind, name: i.name })),
      currency: a.currency,
      totalMinor: a.totalMinor,
      payment: a.payment ? { status: a.payment.status } : null,
      commission: commissionView(a, (id) => barberOf.get(hex(id))),
      payout:
        a.payoutId && paidAt
          ? { id: hex(a.payoutId), paidAt: paidAt.toISOString() }
          : null,
    };
  };
  for (const m of window) {
    const doc = rows.get(hex(m.id));
    if (doc) list.push(rowOf(doc));
  }
  return { total: matches.length, rows: list };
}

/** One cut with everything needed to audit it: operations, money, and how its commission was worked out. */
export async function appointmentDetail(id: ObjectId) {
  const a = await platform.appointments.findOne({ _id: id });
  if (!a) throw new AppError(404, "NOT_FOUND", "Not found");
  const [{ tenantOf, branchOf, barberOf }, customer, payout] =
    await Promise.all([
      names([a]),
      platform.customers.findOne({ _id: a.customerId }),
      a.payoutId ? platform.payouts.findOne({ _id: a.payoutId }) : null,
    ]);
  const tenant = tenantOf.get(hex(a.tenantId));
  const branch = branchOf.get(hex(a.branchId));
  return {
    id: hex(a._id),
    status: a.status,
    source: a.source,
    startAt: a.startAt.toISOString(),
    endAt: a.endAt.toISOString(),
    timeZone: a.timeZone,
    tenant: { id: hex(a.tenantId), name: tenant?.name ?? "" },
    branch: { id: hex(a.branchId), name: branch?.name ?? "" },
    barber: {
      id: hex(a.barberId),
      name: barberOf.get(hex(a.barberId))?.name ?? "",
    },
    customer: customer
      ? {
          name: customer.name,
          phone: customer.phone ?? null,
          email: customer.email ?? null,
        }
      : null,
    items: a.items.map((i) => ({
      kind: i.kind,
      name: i.name,
      durationMin: i.durationMin,
      priceMinor: i.priceMinor,
    })),
    notes: a.notes ?? null,
    cancelReason: a.cancelReason ?? null,
    currency: a.currency,
    subtotalMinor: a.subtotalMinor,
    discountMinor: a.discountMinor,
    totalMinor: a.totalMinor,
    promotion: a.promotion
      ? {
          name: a.promotion.name,
          code: a.promotion.code ?? null,
          amountMinor: a.promotion.amountMinor,
        }
      : null,
    payment: a.payment
      ? {
          status: a.payment.status,
          amountMinor: a.payment.amountMinor,
          applicationFeeMinor: a.payment.applicationFeeMinor ?? null,
          paidAt: a.payment.paidAt?.toISOString() ?? null,
        }
      : null,
    commission: commissionView(a, (barberId) => barberOf.get(hex(barberId))),
    payout: payout
      ? {
          id: hex(payout._id),
          paidAt: payout.paidAt.toISOString(),
          amountMinor: payout.amountMinor,
          reference: payout.reference ?? null,
        }
      : null,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function options(f: { tenantId?: ObjectId; branchId?: ObjectId }) {
  const named = (cursor: AsyncIterable<{ _id: ObjectId; name: string }>) =>
    collect(cursor, (d) => ({ id: hex(d._id), name: d.name }));
  const [tenants, branches, barbers] = await Promise.all([
    named(
      platform.tenants
        .find({})
        .project<WithId<Pick<TenantDoc, "name">>>({ name: 1 })
        .sort({ name: 1 })
        .limit(2000),
    ),
    f.tenantId
      ? named(
          platform.branches
            .find({ tenantId: f.tenantId })
            .project<WithId<Pick<BranchDoc, "name">>>({ name: 1 })
            .sort({ name: 1 })
            .limit(500),
        )
      : [],
    f.tenantId || f.branchId
      ? named(
          platform.barbers
            .find({
              ...(f.tenantId && { tenantId: f.tenantId }),
              ...(f.branchId && { branchId: f.branchId }),
            })
            .project<WithId<Pick<BarberDoc, "name">>>({ name: 1 })
            .sort({ name: 1 })
            .limit(500),
        )
      : [],
  ]);
  return { tenants, branches, barbers };
}
