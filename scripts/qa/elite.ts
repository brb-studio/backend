import { ObjectId } from "mongodb";
import type {
  AppointmentDoc,
  BarberDoc,
  BranchDoc,
  Hours,
  PackageDoc,
  PromotionDoc,
  ServiceDoc,
  TenantDoc,
  TimeOffDoc,
  UserDoc,
} from "../../src/db/collections";
import { resolveCommission } from "../../src/features/platform/commission";
import { DEFAULT_BOOKING } from "../../src/features/tenancy/schemas";
import { PLAN_LIMITS } from "../../src/features/tenancy/subscription";
import { localDate, localToInstant } from "../../src/shared/time";

/**
 * "Barbería Elite": a shop halfway through its setup. Running for ~3 weeks with one branch, two
 * barbers and a short agenda; a second branch with no barbers yet, a barber without an account or
 * commission, services without photos, no products, no SPEI, no cover image.
 */
const DAY = 864e5;
const MIN = 60_000;
// Mexico City on purpose: the one shop whose clock differs from the testers' (Tijuana).
const TZ = "America/Mexico_City";

/** Small deterministic generator, so every run builds the same agenda shape. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const range = (days: number[], open: string, close: string): Hours[] =>
  days.map((weekday) => ({ weekday, open, close }));

export type Shop = {
  tenant: TenantDoc;
  branches: BranchDoc[];
  services: ServiceDoc[];
  packages: PackageDoc[];
  barbers: BarberDoc[];
  users: UserDoc[];
  promotions: PromotionDoc[];
  timeOff: TimeOffDoc[];
  appointments: AppointmentDoc[];
};

export function buildElite(now: Date, passwordHash: string): Shop {
  const tenantId = new ObjectId();
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY);
  const stamp = (daysAgo: number) => ({
    createdAt: at(daysAgo),
    updatedAt: at(daysAgo),
  });

  const roma: BranchDoc = {
    _id: new ObjectId(),
    tenantId,
    slug: "roma",
    name: "Elite Roma",
    address: ["Calle Orizaba 145", "Roma Norte, Ciudad de México"],
    phone: "+525512345678",
    timeZone: TZ,
    hours: range([1, 2, 3, 4, 5, 6], "09:00", "19:00"),
    booking: DEFAULT_BOOKING,
    images: ["/images/sample/branch-norte.jpg"],
    active: true,
    ...stamp(24),
  };
  // Opened in the system last week; nobody works there yet.
  const coyoacan: BranchDoc = {
    _id: new ObjectId(),
    tenantId,
    slug: "coyoacan",
    name: "Elite Coyoacán",
    address: ["Av. Miguel Ángel de Quevedo 870", "Coyoacán, Ciudad de México"],
    timeZone: TZ,
    hours: range([2, 3, 4, 5, 6], "10:00", "18:00"),
    booking: DEFAULT_BOOKING,
    active: true,
    ...stamp(6),
  };

  const service = (
    slug: string,
    position: number,
    durationMin: number,
    priceMinor: number,
    name: ServiceDoc["name"],
    extra: Partial<ServiceDoc> = {},
  ): ServiceDoc => ({
    _id: new ObjectId(),
    tenantId,
    slug,
    position,
    durationMin,
    priceMinor,
    name,
    active: true,
    ...stamp(23),
    ...extra,
  });
  const corte = service(
    "corte",
    1,
    40,
    25_000,
    { es: "Corte", en: "Haircut" },
    {
      description: {
        es: "Corte a tijera o máquina.",
        en: "Scissor or clipper cut.",
      },
      images: ["/images/sample/haircut.jpg"],
    },
  );
  const barba = service(
    "barba",
    2,
    30,
    18_000,
    { es: "Barba", en: "Beard" },
    { images: ["/images/sample/beard.jpg"] },
  );
  const fade = service("fade", 3, 50, 30_000, { es: "Fade", en: "Fade" });
  // Created but switched off while they decide the price.
  const ceja = service(
    "ceja",
    5,
    15,
    8_000,
    { es: "Perfilado de ceja", en: "Eyebrow shaping" },
    { active: false },
  );

  const owner: UserDoc = {
    _id: new ObjectId(),
    tenantId,
    email: "owner@elite.test",
    passwordHash,
    name: "Jorge Elizondo",
    role: "owner",
    active: true,
    emailVerifiedAt: at(24),
    termsAcceptedAt: at(24),
    ...stamp(24),
  };
  const carlosUser: UserDoc = {
    _id: new ObjectId(),
    tenantId,
    email: "carlos@elite.test",
    passwordHash,
    name: "Carlos Mendoza",
    role: "barber",
    branchId: roma._id,
    active: true,
    emailVerifiedAt: at(22),
    termsAcceptedAt: at(22),
    ...stamp(22),
  };
  const carlos: BarberDoc = {
    _id: new ObjectId(),
    tenantId,
    branchId: roma._id,
    userId: carlosUser._id,
    slug: "carlos",
    name: "Carlos Mendoza",
    specialty: { es: "Fades y diseños", en: "Fades & designs" },
    images: ["/images/sample/haircut.jpg"],
    hours: range([1, 2, 3, 4, 5, 6], "09:00", "19:00"),
    serviceIds: [corte._id, barba._id, fade._id],
    commissionBps: 4000,
    active: true,
    ...stamp(22),
  };
  // No account, no photo, no commission configured yet.
  const diego: BarberDoc = {
    _id: new ObjectId(),
    tenantId,
    branchId: roma._id,
    slug: "diego",
    name: "Diego",
    hours: range([2, 3, 4, 5, 6], "10:00", "19:00"),
    serviceIds: [corte._id, fade._id],
    active: true,
    ...stamp(20),
  };

  const customer = (
    email: string | undefined,
    name: string,
    phone: string | undefined,
    daysAgo: number,
  ): UserDoc => ({
    _id: new ObjectId(),
    tenantId,
    name,
    role: "customer",
    active: true,
    ...(email
      ? {
          email,
          passwordHash,
          emailVerifiedAt: at(daysAgo),
          termsAcceptedAt: at(daysAgo),
        }
      : { guest: true as const }),
    ...(phone && { phone }),
    ...stamp(daysAgo),
  });
  const demo = customer(
    "cliente@elite.test",
    "Luis Ángel Ruiz",
    "+525500000100",
    18,
  );
  const customers = [
    demo,
    customer("c01@clientes.elite.test", "Omar Castañeda", "+525500000101", 21),
    customer("c02@clientes.elite.test", "Brayan Soto", undefined, 15),
    customer("c03@clientes.elite.test", "Kevin Ibarra", "+525500000103", 12),
    customer("c04@clientes.elite.test", "Ernesto Valdez", "+525500000104", 9),
    customer("c05@clientes.elite.test", "Ulises Peña", undefined, 4),
    customer(undefined, "Don Ramón (sin cuenta)", "+525500000200", 16),
    customer(undefined, "Cliente de paso", "+525500000201", 7),
  ];

  const promotions: PromotionDoc[] = [
    {
      _id: new ObjectId(),
      tenantId,
      name: { es: "Bienvenido", en: "Welcome" },
      code: "BIENVENIDO",
      type: "percent",
      value: 10,
      firstVisitOnly: true,
      branchIds: [],
      serviceIds: [],
      packageIds: [],
      redemptions: 0,
      active: true,
      ...stamp(19),
    },
  ];

  // Diego is away three days later this week: no bookings for him on those days.
  const today = localDate(now, TZ);
  const day = (offset: number) =>
    Temporal.PlainDate.from(today).add({ days: offset }).toString();
  const awayDays = new Set([day(3), day(4), day(5)]);
  const timeOff: TimeOffDoc[] = [
    {
      _id: new ObjectId(),
      tenantId,
      branchId: roma._id,
      barberId: diego._id,
      startAt: localToInstant(`${day(3)}T00:00`, TZ),
      endAt: localToInstant(`${day(6)}T00:00`, TZ),
      kind: "vacation",
      reason: "Viaje familiar",
      createdBy: owner._id,
      createdAt: at(2),
    },
  ];

  const appointments = buildAgenda({
    now,
    tenantId,
    branch: roma,
    barbers: [
      {
        doc: carlos,
        slots: ["09:30", "11:00", "12:30", "15:00", "16:30", "18:00"],
      },
      { doc: diego, slots: ["10:30", "12:00", "15:30", "17:00"] },
    ],
    services: [corte, barba, fade],
    customers,
    demo,
    receiver: owner._id,
    awayDays,
    day,
  });

  const tenant: TenantDoc = {
    _id: tenantId,
    slug: "elite",
    name: "Barbería Elite",
    currency: "MXN",
    locales: ["es", "en"],
    defaultLocale: "es",
    theme: {
      accent: "#2563eb",
      "accent-fg": "#ffffff",
      "accent-text": { light: "#1d4ed8", dark: "#93c5fd" },
    },
    brand: { instagramUrl: "https://www.instagram.com/" },
    subscription: { plan: "pro", status: "active", limits: PLAN_LIMITS.pro },
    ...stamp(24),
  };

  return {
    tenant,
    branches: [roma, coyoacan],
    services: [corte, barba, fade, ceja],
    packages: [
      {
        _id: new ObjectId(),
        tenantId,
        slug: "corte-barba",
        name: { es: "Corte y barba", en: "Cut & beard" },
        priceMinor: 38_000,
        items: [{ serviceId: corte._id }, { serviceId: barba._id }],
        position: 4,
        active: true,
        ...stamp(20),
      },
    ],
    barbers: [carlos, diego],
    users: [owner, carlosUser, ...customers],
    promotions,
    timeOff,
    appointments,
  };
}

function buildAgenda(ctx: {
  now: Date;
  tenantId: ObjectId;
  branch: BranchDoc;
  barbers: { doc: BarberDoc; slots: string[] }[];
  services: ServiceDoc[];
  customers: UserDoc[];
  demo: UserDoc;
  receiver: ObjectId;
  awayDays: Set<string>;
  day: (offset: number) => string;
}) {
  const random = rng(20261103);
  const docs: AppointmentDoc[] = [];
  const demoPlan = new Map([
    [-12, "corte"],
    [-5, "fade"],
    [2, "corte"],
  ]);
  for (let offset = -18; offset <= 7; offset++) {
    const date = ctx.day(offset);
    const weekday = Temporal.PlainDate.from(date).dayOfWeek % 7;
    for (const { doc: barber, slots } of ctx.barbers) {
      if (!barber.hours.some((h) => h.weekday === weekday)) continue;
      if (barber.slug === "diego" && ctx.awayDays.has(date)) continue;
      // Fewer bookings early on (the shop was just starting) and further ahead.
      const fill = offset < -10 ? 0.35 : offset > 2 ? 0.3 : 0.6;
      slots.forEach((hhmm, i) => {
        const demoSlug =
          barber.slug === "carlos" && i === 1
            ? demoPlan.get(offset)
            : undefined;
        if (!demoSlug && random() > fill) return;
        const offered = ctx.services.filter((s) =>
          barber.serviceIds.some((id) => id.equals(s._id)),
        );
        const svc = demoSlug
          ? (offered.find((s) => s.slug === demoSlug) ?? offered[0])
          : offered[Math.floor(random() * offered.length)];
        const others = ctx.customers.filter((c) => c !== ctx.demo);
        const who = demoSlug
          ? ctx.demo
          : others[Math.floor(random() * others.length)];
        if (!svc || !who) return;
        docs.push(
          appointment({ ...ctx, barber, date, hhmm, svc, who, roll: random() }),
        );
      });
    }
  }
  return docs;
}

function appointment(input: {
  now: Date;
  tenantId: ObjectId;
  branch: BranchDoc;
  barber: BarberDoc;
  receiver: ObjectId;
  date: string;
  hhmm: string;
  svc: ServiceDoc;
  who: UserDoc;
  roll: number;
}): AppointmentDoc {
  const { now, branch, barber, svc, who, roll } = input;
  const startAt = localToInstant(
    `${input.date}T${input.hhmm}`,
    branch.timeZone,
  );
  const endAt = new Date(startAt.getTime() + svc.durationMin * MIN);
  const walkIn = who.guest === true;
  const createdAt = new Date(
    Math.min(
      startAt.getTime() - (walkIn ? 5 * MIN : (1 + Math.floor(roll * 4)) * DAY),
      now.getTime() - 10 * MIN,
    ),
  );
  let status: AppointmentDoc["status"] = "confirmed";
  if (endAt <= now)
    status = roll < 0.1 ? "cancelled" : roll < 0.15 ? "no_show" : "completed";
  else if (roll < 0.05) status = "cancelled";
  const doc: AppointmentDoc = {
    _id: new ObjectId(),
    tenantId: input.tenantId,
    branchId: branch._id,
    barberId: barber._id,
    customerId: who._id,
    status,
    startAt,
    endAt,
    blockedUntil: new Date(endAt.getTime() + branch.booking.bufferMin * MIN),
    timeZone: branch.timeZone,
    items: [
      {
        kind: "service",
        serviceId: svc._id,
        name: svc.name,
        durationMin: svc.durationMin,
        priceMinor: svc.priceMinor,
      },
    ],
    currency: "MXN",
    subtotalMinor: svc.priceMinor,
    discountMinor: 0,
    totalMinor: svc.priceMinor,
    source: walkIn ? "staff" : "online",
    ...(walkIn && { createdBy: barber.userId ?? input.receiver }),
    createdAt,
    updatedAt: createdAt,
  };
  if (status === "cancelled") {
    Object.assign(doc, {
      cancelledAt: new Date(createdAt.getTime() + 60 * MIN),
      cancelledBy: walkIn ? input.receiver : who._id,
      cancelReason: "No puedo asistir",
      updatedAt: new Date(createdAt.getTime() + 60 * MIN),
    });
  }
  if (status === "completed") {
    const commission = resolveCommission(doc, barber.commissionBps);
    if (commission)
      doc.commission = {
        bps: commission.bps,
        amountMinor: commission.amountMinor,
      };
    const paidAt = new Date(Math.min(endAt.getTime() + 5 * MIN, now.getTime()));
    doc.counter = {
      method: roll < 0.6 ? "cash" : roll < 0.9 ? "card" : "transfer",
      amountMinor: doc.totalMinor,
      receivedBy: barber.userId ?? input.receiver,
      at: paidAt,
    };
    doc.updatedAt = paidAt;
  }
  if (status === "no_show")
    doc.updatedAt = new Date(endAt.getTime() + 10 * MIN);
  return doc;
}
