import { ObjectId } from "mongodb";
import { app } from "../src/app";
import {
  type Role,
  type TenantDoc,
  tenants,
  type UserDoc,
  users,
} from "../src/db/collections";
import { createSession } from "../src/features/auth/service";
import { PLAN_LIMITS } from "../src/features/tenancy/subscription";

let seq = 0;
const unique = () => `${Date.now().toString(36)}${seq++}`;

export async function createTenant(overrides: Partial<TenantDoc> = {}) {
  const now = new Date();
  const tenant: TenantDoc = {
    _id: new ObjectId(),
    slug: `t${unique()}`,
    name: "Barbería de prueba",
    currency: "MXN",
    locales: ["es", "en"],
    defaultLocale: "es",
    brand: {},
    subscription: { plan: "pro", status: "active", limits: PLAN_LIMITS.pro },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await tenants.insertOne(tenant);
  return { tenant, host: `${tenant.slug}.localhost` };
}

export const PASSWORD = "correct horse battery";

export async function createUser(
  tenant: TenantDoc,
  role: Role,
  extra: Partial<UserDoc> = {},
) {
  const now = new Date();
  const user: UserDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    email: `${role}-${unique()}@example.com`,
    name: role,
    role,
    active: true,
    passwordHash: await Bun.password.hash(PASSWORD, {
      algorithm: "argon2id",
      memoryCost: 1024,
      timeCost: 1,
    }),
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  await users.insertOne(user);
  const { token } = await createSession(user);
  return { user, token };
}

export const branchInput = (overrides: Record<string, unknown> = {}) => ({
  slug: `b${unique()}`,
  name: "Centro",
  address: ["Av. Revolución 123", "Tijuana"],
  timeZone: "America/Tijuana",
  hours: [
    { weekday: 1, open: "09:00", close: "14:00" },
    { weekday: 1, open: "15:00", close: "20:00" },
  ],
  ...overrides,
});

type Body = { [key: string]: unknown };

export async function api(
  method: string,
  path: string,
  { host, token, body }: { host: string; token?: string; body?: unknown },
) {
  const res = await app.request(path, {
    method,
    headers: {
      "X-Forwarded-Host": host,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : {}) as Body & { error?: { code: string } },
  };
}

export async function createShop(overrides: Partial<TenantDoc> = {}) {
  const { tenant, host } = await createTenant(overrides);
  const owner = await createUser(tenant, "owner");
  const branchId = await addBranch(host, owner.token);
  return {
    tenant,
    host,
    owner,
    branchId,
    asOwner: { host, token: owner.token },
  };
}

export async function addBranch(
  host: string,
  token: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await api("POST", "/v1/branches", {
    host,
    token,
    body: branchInput(overrides),
  });
  if (res.status !== 201)
    throw new Error(`addBranch: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body.id);
}

export async function addBarber(
  host: string,
  token: string,
  branchId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await api("POST", "/v1/barbers", {
    host,
    token,
    body: { branchId, slug: `barber-${unique()}`, name: "Mateo", ...overrides },
  });
  if (res.status !== 201)
    throw new Error(`addBarber: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body.id);
}

export const localDay = (days: number, time: string) =>
  `${new Date(Date.now() + days * 864e5).toISOString().slice(0, 10)}T${time}`;

export type Who = { host: string; token: string };

export async function create(
  who: Who,
  path: string,
  body: Record<string, unknown>,
) {
  const res = await api("POST", path, { ...who, body });
  if (res.status !== 201)
    throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
  return String(res.body.id);
}

export const allWeek = (open: string, close: string) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open, close }));

export const dayIn = (timeZone: string, days: number) =>
  Temporal.Now.plainDateISO(timeZone).add({ days }).toString();

export const instantIn = (timeZone: string, date: string, time: string) =>
  Temporal.PlainDateTime.from(`${date}T${time}`)
    .toZonedDateTime(timeZone)
    .toInstant()
    .toString();

let phoneSeq = 1_000_000;
export const nextPhone = () => `+52664${phoneSeq++}`;

export async function bookingShop(
  options: {
    timeZone?: string;
    booking?: Record<string, number>;
    tenant?: Partial<TenantDoc>;
  } = {},
) {
  const timeZone = options.timeZone ?? "America/Tijuana";
  const { tenant, host, owner, asOwner } = await createShop(options.tenant);
  const branchId = await addBranch(host, owner.token, {
    slug: "centro",
    timeZone,
    hours: allWeek("09:00", "20:00"),
    ...(options.booking && { booking: options.booking }),
  });
  const service = (slug: string, durationMin: number, priceMinor: number) =>
    create(asOwner, "/v1/services", {
      slug,
      name: { es: slug },
      durationMin,
      priceMinor,
    });
  const corte = await service("corte", 45, 30_000);
  const barba = await service("barba", 30, 20_000);
  const masaje = await service("masaje", 30, 25_000);
  const pkg = await create(asOwner, "/v1/packages", {
    slug: "corte-barba",
    name: { es: "Corte y barba" },
    priceMinor: 45_000,
    items: [{ serviceId: corte }, { serviceId: barba }],
  });
  const hours = allWeek("10:00", "18:00");
  const mateo = await addBarber(host, owner.token, branchId, {
    slug: "mateo",
    name: "Mateo",
    hours,
    serviceIds: [corte, barba],
  });
  const lucas = await addBarber(host, owner.token, branchId, {
    slug: "lucas",
    name: "Lucas",
    hours,
    serviceIds: [corte, barba, masaje],
  });
  return {
    tenant,
    host,
    owner,
    asOwner,
    branchId,
    timeZone,
    services: { corte, barba, masaje },
    pkg,
    barbers: { mateo, lucas },
  };
}

export type Shop = Awaited<ReturnType<typeof bookingShop>>;

export const guestBooking = (
  startAt: string,
  extra: Record<string, unknown> = {},
) => ({
  branch: "centro",
  barber: "mateo",
  service: "corte",
  startAt,
  customer: { name: "Ana López", phone: nextPhone() },
  ...extra,
});
