import type { ObjectId } from "mongodb";
import type {
  AppointmentDoc,
  NotificationDoc,
  PayoutDoc,
  ProductOrderDoc,
  WaitlistDoc,
} from "../../src/db/collections";
import { summaryOf } from "../../src/features/notifications/service";
import { expiryFrom, totalOf } from "../../src/features/products/rules";
import { localDate, localToInstant } from "../../src/shared/time";

import { type Catalog, SELLABLE } from "./catalog";
import {
  between,
  chance,
  DAY,
  MINUTE,
  oid,
  pick,
  plainDay,
  rngFor,
  TENANT_ID,
} from "./ids";
import type { People } from "./people";

const tenantId = TENANT_ID;
const hex = (id: ObjectId) => id.toHexString();

type Ctx = { catalog: Catalog; people: People; now: Date };

const nameOf = (people: People) => {
  const names = new Map(people.users.map((u) => [hex(u._id), u.name]));
  return (id: ObjectId) => names.get(hex(id)) ?? "";
};

/** What each barber's bell shows (last 48 h) and what the demo customer was told about his next visits. */
export function buildNotifications(
  appointments: AppointmentDoc[],
  { catalog, people, now }: Ctx,
): NotificationDoc[] {
  const docs: NotificationDoc[] = [];
  const name = nameOf(people);
  const branchOf = new Map(catalog.branches.map((b) => [hex(b._id), b]));
  const recent = appointments.filter(
    (a) =>
      a.createdAt.getTime() > now.getTime() - 2 * DAY && a.source === "online",
  );
  for (const barber of people.barbers) {
    if (!barber.userId) continue;
    const rng = rngFor(`notify:${barber.slug}`);
    const mine = recent
      .filter((a) => a.barberId.equals(barber._id))
      .slice(-between(rng, 6, 10));
    for (const a of mine) {
      const branch = branchOf.get(hex(a.branchId));
      if (!branch) continue;
      const type =
        a.status === "cancelled"
          ? "appointment.cancelled"
          : chance(rng, 0.15)
            ? "appointment.rescheduled"
            : "appointment.booked";
      const createdAt = a.cancelledAt ?? a.createdAt;
      docs.push({
        _id: oid(`notif:${hex(a._id)}:${type}`),
        tenantId,
        userId: barber.userId,
        type,
        appointmentId: a._id,
        summary: summaryOf(a, branch, name(a.customerId)),
        ...(chance(rng, 0.5) && {
          readAt: new Date(
            Math.min(createdAt.getTime() + 30 * MINUTE, now.getTime()),
          ),
        }),
        createdAt,
      });
    }
  }
  const upcoming = appointments.filter(
    (a) =>
      a.customerId.equals(people.ids.demo) &&
      a.status === "confirmed" &&
      a.startAt > now,
  );
  for (const [i, a] of upcoming.entries()) {
    const branch = branchOf.get(hex(a.branchId));
    const barber = people.barbers.find((b) => b._id.equals(a.barberId));
    if (!branch) continue;
    const summary = summaryOf(a, branch, name(a.customerId), barber?.name);
    docs.push({
      _id: oid(`notif:${hex(a._id)}:customer.booked`),
      tenantId,
      userId: people.ids.demo,
      type: "customer.booked",
      appointmentId: a._id,
      summary,
      readAt: a.createdAt,
      createdAt: a.createdAt,
    });
    if (i === 0)
      docs.push({
        _id: oid(`notif:${hex(a._id)}:customer.reminder`),
        tenantId,
        userId: people.ids.demo,
        type: "customer.reminder",
        appointmentId: a._id,
        summary,
        createdAt: new Date(now.getTime() - 2 * 60 * MINUTE),
      });
  }
  return docs;
}

/** People waiting for a gap today or tomorrow; the demo customer waits for a late slot with Emilio tomorrow. */
export function buildWaitlist({ catalog, people, now }: Ctx): WaitlistDoc[] {
  const docs: WaitlistDoc[] = [];
  const accounts = people.profiles.filter((p) => p.kind === "account");
  const cuts = catalog.services.filter((s) =>
    ["corte-signature", "fade-de-autor", "barba-ritual"].includes(s.slug),
  );
  const entry = (
    key: string,
    branchSlug: string,
    customerId: ObjectId,
    dayOffset: number,
    from: string,
    to: string,
    notified: boolean,
    barberSlug?: string,
    itemSlug?: string,
  ) => {
    const branch = catalog.branches.find((b) => b.slug === branchSlug);
    const rng = rngFor(`wait:${key}`);
    const service = cuts.find((s) => s.slug === itemSlug) ?? pick(rng, cuts);
    if (!branch) return;
    const date = plainDay(localDate(now, branch.timeZone), dayOffset);
    const createdAt = new Date(now.getTime() - between(rng, 30, 600) * MINUTE);
    docs.push({
      _id: oid(`wait:${key}`),
      tenantId,
      customerId,
      branchId: branch._id,
      item: { kind: "service", slug: service.slug, name: service.name },
      ...(barberSlug && { barberId: oid(`barber:${barberSlug}`) }),
      date,
      from,
      to,
      status: notified ? "notified" : "waiting",
      ...(notified && { notifiedAt: new Date(now.getTime() - 20 * MINUTE) }),
      expiresAt: localToInstant(`${plainDay(date, 1)}T00:00`, branch.timeZone),
      createdAt,
    });
  };
  entry(
    "demo",
    "polanco",
    people.ids.demo,
    1,
    "17:00",
    "20:00",
    false,
    "emilio",
    "corte-signature",
  );
  const slots: [string, number, string, string, boolean][] = [
    ["polanco", 0, "16:00", "20:00", false],
    ["polanco", 1, "10:00", "13:00", true],
    ["providencia", 0, "17:00", "20:00", false],
    ["providencia", 1, "12:00", "15:00", false],
    ["sanpedro", 0, "15:00", "19:00", true],
    ["sanpedro", 1, "09:00", "12:00", false],
  ];
  for (const [i, [branch, offset, from, to, notified]] of slots.entries()) {
    const customer = accounts[(i * 11 + 3) % accounts.length];
    if (customer)
      entry(`w${i}`, branch, customer.id, offset, from, to, notified);
  }
  return docs;
}

/** Reservations, pickups (two or three today per branch, paid cash or SPEI) and a few closed ones. */
export function buildProductOrders({
  catalog,
  people,
  now,
}: Ctx): ProductOrderDoc[] {
  const docs: ProductOrderDoc[] = [];
  const sellable = catalog.products.filter((p) => SELLABLE.includes(p.slug));
  const accounts = people.profiles.filter((p) => p.kind === "account");
  const order = (
    key: string,
    branchSlug: string,
    customerId: ObjectId,
    status: ProductOrderDoc["status"],
    createdAt: Date,
    extra: Partial<ProductOrderDoc> = {},
    slugs?: string[],
  ) => {
    const branch = catalog.branches.find((b) => b.slug === branchSlug);
    if (!branch) return;
    const rng = rngFor(`order:${key}`);
    const chosen = slugs
      ? sellable.filter((p) => slugs.includes(p.slug))
      : [
          pick(rng, sellable),
          ...(chance(rng, 0.35) ? [pick(rng, sellable)] : []),
        ];
    const lines = new Map(chosen.map((p) => [p.slug, p]));
    const items = [...lines.values()].map((p) => ({
      productId: p._id,
      name: p.name,
      priceMinor: p.priceMinor,
      quantity: p.slug === "kit-regalo" ? 1 : between(rng, 1, 2),
    }));
    docs.push({
      _id: oid(`order:${key}`),
      tenantId,
      branchId: branch._id,
      customerId,
      status,
      items,
      currency: "MXN",
      totalMinor: totalOf(items),
      expiresAt: expiryFrom(createdAt),
      createdAt,
      updatedAt: extra.closedAt ?? createdAt,
      ...extra,
    });
  };
  /** Who hands products over at a branch: the manager first, then its barbers (so today's cash shows several people). */
  const staffAt = (branchSlug: string) => {
    const manager = people.managers.get(branchSlug);
    const barbers = people.barbers.flatMap((b) =>
      b.branchId.equals(oid(`branch:${branchSlug}`)) && b.userId
        ? [b.userId]
        : [],
    );
    return manager ? [manager, ...barbers] : barbers;
  };
  const delivered = (
    key: string,
    branchSlug: string,
    at: Date,
    turn?: number,
  ) => {
    const rng = rngFor(`pickup:${key}`);
    const customer = pick(rng, accounts);
    const staff = staffAt(branchSlug);
    const by =
      (turn === undefined ? pick(rng, staff) : staff[turn % staff.length]) ??
      people.ids.owner;
    order(
      key,
      branchSlug,
      customer.id,
      "delivered",
      new Date(at.getTime() - between(rng, 2, 72) * 60 * MINUTE),
      {
        payment: {
          method: chance(rng, 0.7) ? "cash" : "spei",
          receivedBy: by,
          at,
        },
        closedAt: at,
        closedBy: by,
      },
    );
  };

  order(
    "demo",
    "polanco",
    people.ids.demo,
    "reserved",
    new Date(now.getTime() - 26 * 60 * MINUTE),
    {},
    ["pomada-mate", "aceite-barba"],
  );
  for (const [i, branch] of ["providencia", "sanpedro"].entries()) {
    const customer = accounts[(i * 17 + 5) % accounts.length];
    if (customer)
      order(
        `reserved-${i}`,
        branch,
        customer.id,
        "reserved",
        new Date(now.getTime() - (i + 1) * 20 * 60 * MINUTE),
      );
  }
  for (const branch of catalog.branches) {
    const start = localToInstant(
      `${localDate(now, branch.timeZone)}T00:00`,
      branch.timeZone,
    ).getTime();
    const count = 3;
    for (let i = 0; i < count; i++) {
      const at = Math.max(
        start + MINUTE,
        now.getTime() - (i * 50 + 15) * MINUTE,
      );
      delivered(`today-${branch.slug}-${i}`, branch.slug, new Date(at), i);
    }
  }
  for (let i = 0; i < 25; i++) {
    const rng = rngFor(`history-order:${i}`);
    const branch = pick(rng, catalog.branches);
    const at = new Date(
      now.getTime() -
        between(rng, 1, 30) * DAY -
        between(rng, 60, 480) * MINUTE,
    );
    delivered(`past-${i}`, branch.slug, at);
  }
  for (let i = 0; i < 2; i++) {
    const customer = accounts[(i * 23 + 9) % accounts.length];
    if (!customer) continue;
    const created = new Date(now.getTime() - (10 + i * 6) * DAY);
    order(`cancelled-${i}`, "polanco", customer.id, "cancelled", created, {
      closedAt: new Date(created.getTime() + DAY),
      closedBy: customer.id,
    });
    const old = new Date(now.getTime() - (12 + i * 5) * DAY);
    order(`expired-${i}`, "providencia", customer.id, "expired", old, {
      closedAt: expiryFrom(old),
    });
  }
  return docs;
}

/** Two commission payouts last month at Polanco, settling every commission those barbers earned that month. */
export function buildPayouts(
  appointments: AppointmentDoc[],
  { catalog, people, now }: Ctx,
): PayoutDoc[] {
  const polanco = catalog.branches.find((b) => b.slug === "polanco");
  if (!polanco) return [];
  const thisMonth = `${localDate(now, polanco.timeZone).slice(0, 7)}-01`;
  const lastMonth = Temporal.PlainDate.from(thisMonth)
    .subtract({ months: 1 })
    .toString()
    .slice(0, 7);
  const paidAt = new Date(
    Math.min(
      localToInstant(`${thisMonth}T19:00`, polanco.timeZone).getTime(),
      now.getTime() - MINUTE,
    ),
  );
  const docs: PayoutDoc[] = [];
  for (const slug of ["emilio", "santiago"]) {
    const barberId = oid(`barber:${slug}`);
    const settled = appointments.filter(
      (a) =>
        a.barberId.equals(barberId) &&
        a.status === "completed" &&
        a.commission &&
        localDate(a.startAt, a.timeZone).startsWith(lastMonth) &&
        a.startAt < paidAt,
    );
    if (settled.length === 0) continue;
    const _id = oid(`payout:${slug}:${lastMonth}`);
    for (const a of settled) a.payoutId = _id;
    docs.push({
      _id,
      tenantId,
      barberId,
      currency: "MXN",
      amountMinor: settled.reduce(
        (sum, a) => sum + (a.commission?.amountMinor ?? 0),
        0,
      ),
      appointmentIds: settled.map((a) => a._id),
      reference: `Comisiones ${lastMonth}`,
      paidAt,
      createdBy: people.ids.owner,
      createdAt: paidAt,
    });
  }
  return docs;
}
