import type { ObjectId } from "mongodb";
import type {
  AppointmentDoc,
  BarberDoc,
  BranchDoc,
  ServiceDoc,
  TimeOffDoc,
} from "../../src/db/collections";
import { snapshot } from "../../src/features/booking/order";
import { packageServices } from "../../src/features/catalog/rules";
import { localDate, localToInstant } from "../../src/shared/time";
import type { Catalog } from "./catalog";
import {
  between,
  chance,
  MINUTE,
  oid,
  pick,
  plainDay,
  type Rng,
  rngFor,
  TENANT_ID,
  toHHMM,
  toMinutes,
  weekdayOf,
  weighted,
} from "./ids";
import type { People, Profile } from "./people";
import { busyFrom, type Interval } from "./timeoff";

/** An appointment plus what it was booked for (promotions are evaluated against the item). */
export type Booking = {
  doc: AppointmentDoc;
  item: { kind: "service" | "package"; id: ObjectId };
};

export const DENSE_DAYS = 70;
export const ARCHIVE_DAYS = 365;
export const AHEAD_DAYS = 14;

const ITEM_WEIGHTS: Record<string, number> = {
  "corte-signature": 30,
  "fade-de-autor": 20,
  "corte-tijera": 8,
  "barba-ritual": 10,
  "afeitado-navaja": 5,
  "corte-nino": 4,
  "perfilado-cejas": 2,
  "facial-carbon": 3,
  "camuflaje-canas": 6,
  "corte-barba": 8,
  "ritual-montecobre": 4,
  "padre-e-hijo": 2,
  "dia-del-novio": 1,
};
const WEEKDAY_WEIGHT = [0.9, 0.8, 0.85, 0.9, 1, 1.15, 1.25];
const CANCEL_REASONS = [
  "El cliente reagendó",
  "Imprevisto del cliente",
  "Se enfermó",
  "Cambio de planes",
];

type Offer = {
  slug: string;
  durationMin: number;
  booking: ReturnType<typeof snapshot>;
  weight: number;
};

/** What a barber can be booked for, with the frozen snapshot the booking flow would store. */
export function offersOf(barber: BarberDoc, catalog: Catalog): Offer[] {
  const mine = (s: ServiceDoc) =>
    barber.serviceIds.some((id) => id.equals(s._id)) &&
    (!s.branchId || s.branchId.equals(barber.branchId));
  const services = catalog.services.filter(mine);
  const offers: Offer[] = services.map((s) => ({
    slug: s.slug,
    durationMin: s.durationMin,
    booking: snapshot({ services: [s] }),
    weight: ITEM_WEIGHTS[s.slug] ?? 1,
  }));
  for (const pkg of catalog.packages) {
    const list = packageServices(pkg, catalog.services);
    if (
      !list?.every(mine) ||
      (pkg.branchId && !pkg.branchId.equals(barber.branchId))
    )
      continue;
    const booking = snapshot({ services: list, pkg });
    offers.push({
      slug: pkg.slug,
      durationMin: booking.durationMin,
      booking,
      weight: ITEM_WEIGHTS[pkg.slug] ?? 1,
    });
  }
  return offers;
}

/** Visits the demo customer made (and will make): 8 done, 1 cancelled, 2 ahead, so the loyalty card shows 4 of 6. */
const DEMO_PINS: [
  offset: number,
  item: string,
  status: "completed" | "cancelled" | "confirmed",
][] = [
  [-112, "corte-signature", "completed"],
  [-98, "fade-de-autor", "completed"],
  [-84, "corte-barba", "completed"],
  [-70, "corte-signature", "completed"],
  [-56, "fade-de-autor", "completed"],
  [-35, "corte-signature", "completed"],
  [-21, "corte-barba", "completed"],
  [-14, "corte-signature", "completed"],
  [-7, "corte-signature", "cancelled"],
  [2, "fade-de-autor", "confirmed"],
  [9, "corte-barba", "confirmed"],
];

type Pin = {
  start: number;
  offer: Offer;
  customer: Profile;
  status: (typeof DEMO_PINS)[number][2];
};

function demoPins(
  barber: BarberDoc,
  offers: Offer[],
  profile: Profile,
  today: string,
) {
  const pins = new Map<string, Pin>();
  for (const [offset, slug, status] of DEMO_PINS) {
    const offer = offers.find((o) => o.slug === slug);
    if (!offer) continue;
    for (let shift = 0; shift < 7; shift++) {
      const date = plainDay(today, offset + (offset < 0 ? -shift : shift));
      const first = barber.hours
        .filter((h) => h.weekday === weekdayOf(date))
        .sort((a, b) => a.open.localeCompare(b.open))[0];
      if (!first) continue;
      pins.set(date, {
        start: toMinutes(first.open) + 60,
        offer,
        customer: profile,
        status,
      });
      break;
    }
  }
  return pins;
}

function fillChance(date: string, offset: number) {
  const weekday = WEEKDAY_WEIGHT[weekdayOf(date)] ?? 1;
  if (offset < -DENSE_DAYS) return 0.025;
  if (offset > 0)
    return Math.min(0.9, (0.65 - (0.45 * offset) / AHEAD_DAYS) * weekday);
  const growth = 1 + 0.02 * ((DENSE_DAYS + offset) / 7);
  const dayOfMonth = Number(date.slice(8));
  const payday =
    (dayOfMonth >= 14 && dayOfMonth <= 16) ||
    dayOfMonth >= 29 ||
    dayOfMonth === 1
      ? 1.12
      : 1;
  return Math.min(0.95, 0.6 * weekday * growth * payday);
}

function customerFor(
  rng: Rng,
  pools: Map<string, Profile[]>,
  all: Profile[],
  branch: string,
  at: Date,
) {
  const pool = chance(rng, 0.8) ? (pools.get(branch) ?? all) : all;
  const eligible = pool.filter(
    (p) => p.weight > 0 && p.since <= at && (!p.until || at < p.until),
  );
  if (eligible.length === 0) return undefined;
  return weighted(
    rng,
    eligible.map((p): [Profile, number] => [p, p.weight]),
  );
}

/** Every appointment of the showcase, generated barber by barber and day by day, never overlapping. */
export function buildAgenda(
  catalog: Catalog,
  people: People,
  timeOff: TimeOffDoc[],
  now: Date,
): Booking[] {
  const bookings: Booking[] = [];
  const pools = new Map<string, Profile[]>();
  for (const p of people.profiles)
    pools.set(p.home, [...(pools.get(p.home) ?? []), p]);
  const demo = people.profiles.find((p) => p.kind === "demo");
  for (const barber of people.barbers) {
    const branch = catalog.branches.find((b) => b._id.equals(barber.branchId));
    if (!branch) continue;
    const offers = offersOf(barber, catalog);
    const today = localDate(now, branch.timeZone);
    const pins =
      barber.slug === "emilio" && demo
        ? demoPins(barber, offers, demo, today)
        : new Map<string, Pin>();
    for (let offset = -ARCHIVE_DAYS; offset <= AHEAD_DAYS; offset++) {
      const date = plainDay(today, offset);
      const segments = barber.hours
        .filter((h) => h.weekday === weekdayOf(date))
        .map((h): Interval => [toMinutes(h.open), toMinutes(h.close)]);
      if (segments.length === 0) continue;
      const rng = rngFor(`day:${barber.slug}:${date}`);
      const busy = busyFrom(timeOff, barber, date, branch.timeZone);
      const pin = pins.get(date);
      if (pin) {
        busy.push([pin.start, pin.start + pin.offer.durationMin]);
        bookings.push(
          book({
            barber,
            branch,
            date,
            start: pin.start,
            offer: pin.offer,
            customer: pin.customer,
            rng,
            now,
            status: pin.status,
          }),
        );
      }
      const p = fillChance(date, offset);
      for (const [open, close] of segments.sort((a, b) => a[0] - b[0])) {
        let cursor = open;
        while (cursor < close) {
          const offer = weighted(
            rng,
            offers.map((o): [Offer, number] => [o, o.weight]),
          );
          const end = cursor + offer.durationMin;
          const clash = busy.find(([a, b]) => cursor < b && a < end);
          if (clash) {
            cursor = Math.ceil(clash[1] / 15) * 15;
            continue;
          }
          if (end > close) {
            cursor += 15;
            continue;
          }
          if (!chance(rng, p)) {
            cursor += 30;
            continue;
          }
          const at = localToInstant(
            `${date}T${toHHMM(cursor)}`,
            branch.timeZone,
          );
          const customer = customerFor(
            rng,
            pools,
            people.profiles,
            branch.slug,
            at,
          );
          if (customer)
            bookings.push(
              book({
                barber,
                branch,
                date,
                start: cursor,
                offer,
                customer,
                rng,
                now,
              }),
            );
          cursor = Math.ceil((end + (chance(rng, 0.2) ? 15 : 0)) / 15) * 15;
        }
      }
    }
  }
  return bookings.sort(
    (a, b) => a.doc.startAt.getTime() - b.doc.startAt.getTime(),
  );
}

function book(input: {
  barber: BarberDoc;
  branch: BranchDoc;
  date: string;
  start: number;
  offer: Offer;
  customer: Profile;
  rng: Rng;
  now: Date;
  status?: AppointmentDoc["status"];
}): Booking {
  const { barber, branch, offer, customer, rng, now } = input;
  const hhmm = toHHMM(input.start);
  const startAt = localToInstant(`${input.date}T${hhmm}`, branch.timeZone);
  const endAt = new Date(startAt.getTime() + offer.durationMin * MINUTE);
  const status = input.status ?? statusOf(rng, customer, startAt, endAt, now);
  const walkIn =
    customer.kind !== "demo" &&
    chance(rng, customer.kind === "guest" ? 0.4 : 0.3);
  const lead = walkIn
    ? between(rng, 0, 10) * MINUTE
    : between(rng, 1, 14) * 864e5 + between(rng, 0, 600) * MINUTE;
  const createdAt = new Date(
    Math.max(
      customer.since.getTime(),
      Math.min(startAt.getTime() - lead, now.getTime() - 5 * MINUTE),
    ),
  );
  const doc: AppointmentDoc = {
    _id: oid(`appt:${barber.slug}:${input.date}:${hhmm}`),
    tenantId: TENANT_ID,
    branchId: branch._id,
    barberId: barber._id,
    customerId: customer.id,
    status,
    startAt,
    endAt,
    blockedUntil: new Date(endAt.getTime() + branch.booking.bufferMin * MINUTE),
    timeZone: branch.timeZone,
    items: offer.booking.items,
    currency: "MXN",
    subtotalMinor: offer.booking.subtotalMinor,
    discountMinor: 0,
    totalMinor: offer.booking.subtotalMinor,
    source: walkIn ? "staff" : "online",
    ...(walkIn && barber.userId && { createdBy: barber.userId }),
    createdAt,
    updatedAt: createdAt,
  };
  if (status === "cancelled") {
    const span = Math.max(
      MINUTE,
      Math.min(startAt.getTime(), now.getTime()) - createdAt.getTime(),
    );
    const cancelledAt = new Date(
      createdAt.getTime() + Math.floor(rng() * span),
    );
    const byCustomer = doc.source === "online" && customer.kind !== "guest";
    const by = byCustomer ? customer.id : barber.userId;
    Object.assign(doc, {
      cancelledAt,
      ...(by && { cancelledBy: by }),
      cancelReason: pick(rng, CANCEL_REASONS),
      updatedAt: cancelledAt,
    });
  } else if (status === "completed" || status === "no_show") {
    doc.updatedAt = new Date(
      Math.min(endAt.getTime() + 10 * MINUTE, now.getTime()),
    );
  }
  return { doc, item: offer.booking.item };
}

function statusOf(
  rng: Rng,
  customer: Profile,
  startAt: Date,
  endAt: Date,
  now: Date,
): AppointmentDoc["status"] {
  if (endAt <= now) {
    if (chance(rng, 0.08)) return "cancelled";
    return chance(rng, customer.flaky) ? "no_show" : "completed";
  }
  if (startAt > now && chance(rng, 0.04)) return "cancelled";
  return "confirmed";
}
