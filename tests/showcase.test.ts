import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ObjectId } from "mongodb";
import { PROMO } from "../scripts/showcase/catalog";
import {
  assertFreeDatabase,
  assertSafeTarget,
  GuardError,
} from "../scripts/showcase/guard";
import { SLUG, TENANT_ID } from "../scripts/showcase/ids";
import {
  type Counts,
  countShowcase,
  DEMO_PASSWORD,
  seedShowcase,
} from "../scripts/showcase/write";
import {
  type AppointmentDoc,
  appointments,
  barbers,
  branches,
  COUNTER_METHODS,
  images,
  notifications,
  payouts,
  productOrders,
  promotions,
  tenants,
  timeOff,
  users,
  waitlist,
} from "../src/db/collections";
import { dueAtCounter } from "../src/features/booking/counter";
import { commissionOf } from "../src/features/platform/commission";
import { instantToLocal, localDate, localToInstant } from "../src/shared/time";
import { api, createTenant, createUser } from "./helpers";

const HOST = `${SLUG}.localhost`;
const ZONE = "America/Mexico_City";
const TODAY = localDate(new Date(), ZONE);
/** Midday today in Mexico City: every branch is open, and API reads that use the real clock agree. */
const T = localToInstant(`${TODAY}T13:00`, ZONE);
const DAY = 864e5;
const safe = {
  nodeEnv: "development",
  mongoUrl: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
  dbName: "brb-showcase",
};
const hex = (id: ObjectId) => id.toHexString();

describe("guards (pure)", () => {
  test("refuses production, Vercel, live Stripe keys, remote hosts and other databases", () => {
    for (const ok of ["brb-showcase", "brb-showcase_e2e", "anything_test"]) {
      expect(() => assertSafeTarget({ ...safe, dbName: ok })).not.toThrow();
    }
    const twoLocal = { ...safe, mongoUrl: "mongodb://localhost,[::1]:27018" };
    expect(() => assertSafeTarget(twoLocal)).not.toThrow();
    const refused = [
      { ...safe, nodeEnv: "production" },
      { ...safe, vercel: "1" },
      { ...safe, stripeKey: "rk_live_abc" },
      { ...safe, mongoUrl: "mongodb+srv://cluster.example.com" },
      { ...safe, mongoUrl: "mongodb://db.example.com:27017" },
      { ...safe, mongoUrl: "mongodb://127.0.0.1,db.example.com" },
      { ...safe, dbName: "brb-studio" },
      { ...safe, dbName: "magicstudio" },
      { ...safe, dbName: "brb-showcase-prod" },
    ];
    for (const target of refused) {
      expect(() => assertSafeTarget(target)).toThrow(GuardError);
    }
  });

  test("refuses a taken slug, and a database with other tenants unless shared", () => {
    const base = { dbName: "brb-showcase", otherTenants: [], shared: false };
    expect(() => assertFreeDatabase(base)).not.toThrow();
    expect(() =>
      assertFreeDatabase({ ...base, slugOwner: TENANT_ID }),
    ).not.toThrow();
    expect(() =>
      assertFreeDatabase({ ...base, slugOwner: new ObjectId(), shared: true }),
    ).toThrow(/already belongs/);
    expect(() =>
      assertFreeDatabase({ ...base, otherTenants: ["elite"] }),
    ).toThrow(/--shared/);
    expect(() =>
      assertFreeDatabase({ ...base, otherTenants: ["elite"], shared: true }),
    ).not.toThrow();
  });
});

async function runCli(env: Record<string, string>) {
  const proc = Bun.spawn(
    [
      "bun",
      "--no-env-file",
      join(import.meta.dir, "../scripts/seed-showcase.ts"),
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { code, stderr };
}

describe("seed:showcase CLI", () => {
  const local = {
    MONGO_URL: "mongodb://127.0.0.1:27017/?replicaSet=rs0",
    MONGO_DB: "brb-showcase_test",
  };
  test("refuses NODE_ENV=production before writing", async () => {
    const secret = "x".repeat(40);
    const res = await runCli({
      ...local,
      NODE_ENV: "production",
      PROXY_SECRET: secret,
      PAYMENT_TOKEN_SECRET: secret,
    });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("NODE_ENV=production");
    expect(await tenants.countDocuments({ slug: SLUG })).toBe(0);
  });
  test("refuses a non-local MongoDB and a database outside the allowlist", async () => {
    const remote = await runCli({
      ...local,
      NODE_ENV: "development",
      MONGO_URL: "mongodb://db.example.com:27017",
    });
    expect(remote.code).not.toBe(0);
    expect(remote.stderr).toContain("only localhost");
    const other = await runCli({
      ...local,
      NODE_ENV: "development",
      MONGO_DB: "magicstudio",
    });
    expect(other.code).not.toBe(0);
    expect(other.stderr).toContain('not "magicstudio"');
    expect(await tenants.countDocuments({ slug: SLUG })).toBe(0);
  });
});

describe("seedShowcase against MongoDB", () => {
  let other: ObjectId;
  let otherBefore: number[];
  const otherCounts = () =>
    Promise.all(
      [users, branches, appointments].map((c) =>
        c.countDocuments({ tenantId: other }),
      ),
    );
  let first: Counts;

  beforeAll(async () => {
    const { tenant } = await createTenant({ slug: "otra" });
    other = tenant._id;
    await createUser(tenant, "owner", { email: "owner@otra.test" });
    await createUser(tenant, "customer", { email: "cliente@montecobre.test" });
    otherBefore = await otherCounts();
  });
  afterAll(async () => {
    await tenants.deleteOne({ _id: other });
  });

  test("a slug owned by another tenant fails without writing", async () => {
    const { tenant: squatter } = await createTenant({ slug: SLUG });
    await expect(seedShowcase({ now: T, shared: true })).rejects.toThrow(
      /already belongs/,
    );
    const counts = await countShowcase();
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    await tenants.deleteOne({ _id: squatter._id });
  });

  test("refuses a database with other tenants unless --shared", async () => {
    await expect(seedShowcase({ now: T })).rejects.toThrow(/--shared/);
    expect((await countShowcase()).tenants).toBe(0);
  });

  test("a rerun is a no-op: same counts and ids, other tenants untouched", async () => {
    first = (await seedShowcase({ now: T, shared: true })).counts;
    const stableIds = () =>
      Promise.all(
        [users, barbers, promotions].map((c) =>
          c.distinct("_id", { tenantId: TENANT_ID }),
        ),
      );
    const ids = await stableIds();
    const second = (await seedShowcase({ now: T, shared: true })).counts;
    expect(second).toEqual(first);
    expect(await stableIds()).toEqual(ids);
    expect(first).toMatchObject({
      tenants: 1,
      branches: 3,
      barbers: 10,
      services: 9,
      packages: 4,
      products: 9,
      promotions: 6,
      payments: 0,
      pushSubscriptions: 0,
    });
    expect(first.users).toBe(1 + 1 + 3 + 9 + 1 + 70 + 10 + 1);
    expect(first.appointments).toBeGreaterThan(3000);
    expect(await otherCounts()).toEqual(otherBefore);
    // Nothing of the showcase leaked into another tenant.
    const mine = await users.distinct("_id", { tenantId: TENANT_ID });
    expect(
      await appointments.countDocuments({
        tenantId: { $ne: TENANT_ID },
        customerId: { $in: mine },
      }),
    ).toBe(0);
  });

  test("appointments are consistent: no overlap, inside hours, outside time off, money and counter right", async () => {
    const barberList = await barbers.find({ tenantId: TENANT_ID }).toArray();
    const barberOf = new Map(barberList.map((b) => [hex(b._id), b]));
    const branchOf = new Map(
      (await branches.find({ tenantId: TENANT_ID }).toArray()).map((b) => [
        hex(b._id),
        b,
      ]),
    );
    const idSet = async (filter: Parameters<typeof users.find>[0]) =>
      new Set((await users.find(filter).toArray()).map((u) => hex(u._id)));
    const staff = await idSet({
      tenantId: TENANT_ID,
      role: { $ne: "customer" },
    });
    const people = await idSet({ tenantId: TENANT_ID });
    const gaps = await timeOff.find({ tenantId: TENANT_ID }).toArray();
    const all = await appointments
      .find({ tenantId: TENANT_ID })
      .sort({ startAt: 1 })
      .toArray();
    const lastEnd = new Map<string, Date>();
    for (const a of all) {
      const barber = barberOf.get(hex(a.barberId));
      expect(barber?.branchId.equals(a.branchId)).toBe(true);
      expect(branchOf.has(hex(a.branchId))).toBe(true);
      expect(people.has(hex(a.customerId))).toBe(true);
      for (const n of [a.subtotalMinor, a.discountMinor, a.totalMinor])
        expect(Number.isInteger(n)).toBe(true);
      expect(a.totalMinor).toBe(a.subtotalMinor - a.discountMinor);
      if (!barber) continue;
      const start = instantToLocal(a.startAt, a.timeZone);
      const end = instantToLocal(a.endAt, a.timeZone);
      const weekday = Temporal.PlainDate.from(start.slice(0, 10)).dayOfWeek % 7;
      const inHours = barber.hours.some(
        (h) =>
          h.weekday === weekday &&
          h.open <= start.slice(11) &&
          end.slice(11) <= h.close &&
          end.slice(0, 10) === start.slice(0, 10),
      );
      expect(inHours).toBe(true);
      const blocked = gaps.some(
        (g) =>
          g.branchId.equals(a.branchId) &&
          (!g.barberId || g.barberId.equals(a.barberId)) &&
          g.startAt < a.endAt &&
          a.startAt < g.endAt,
      );
      expect(blocked).toBe(false);
      const key = hex(a.barberId);
      const prev = lastEnd.get(key);
      expect(!prev || prev <= a.startAt).toBe(true);
      lastEnd.set(key, a.endAt);

      if (a.status !== "completed") {
        expect(a.counter).toBeUndefined();
        expect(a.commission).toBeUndefined();
      }
      if (a.counter) {
        expect(a.counter.amountMinor).toBe(dueAtCounter(a));
        expect(staff.has(hex(a.counter.receivedBy))).toBe(true);
        expect(a.counter.at >= a.endAt && a.counter.at <= T).toBe(true);
        expect(COUNTER_METHODS).toContain(a.counter.method);
      }
      if (a.status === "completed") {
        if (barber.commissionBps === undefined)
          expect(a.commission).toBeUndefined();
        else
          expect(a.commission).toEqual({
            bps: barber.commissionBps,
            amountMinor: commissionOf(a.totalMinor, barber.commissionBps),
          });
      }
      if (a.status === "cancelled")
        expect(a.cancelledAt && a.cancelReason).toBeTruthy();
      expect(a.status).not.toBe("pending_payment");
    }
    const ricardo = barberList.find((b) => b.slug === "ricardo");
    expect(ricardo?.commissionBps).toBeUndefined();
    const owner = await users.findOne({
      email: "owner@montecobre.test",
      tenantId: TENANT_ID,
    });
    expect(ricardo?.userId).toEqual(owner?._id);
  });

  test("today: exactly two visits left unrecorded and one open visit per branch", async () => {
    const today = await appointments
      .find({
        tenantId: TENANT_ID,
        startAt: {
          $gte: localToInstant(`${TODAY}T00:00`, ZONE),
          $lt: localToInstant(`${TODAY}T23:59`, ZONE),
        },
      })
      .toArray();
    const unrecorded = today.filter(
      (a) => a.status === "completed" && !a.counter,
    );
    expect(unrecorded.length).toBe(2);
    const open = today.filter((a) => a.status === "confirmed" && a.endAt <= T);
    expect(new Set(open.map((a) => hex(a.branchId))).size).toBe(3);
  });

  test("loyalty: the 6-visit promo only lands on multiples of 6 and redemptions match", async () => {
    const all = await appointments
      .find({ tenantId: TENANT_ID })
      .sort({ startAt: 1 })
      .toArray();
    const visits = new Map<string, number>();
    const used = new Map<string, number>();
    for (const a of all) {
      const key = hex(a.customerId);
      const before = visits.get(key) ?? 0;
      if (a.promotion?.promotionId.equals(PROMO.loyalty))
        expect((before + 1) % 6).toBe(0);
      if (a.promotion && a.status !== "cancelled")
        used.set(
          hex(a.promotion.promotionId),
          (used.get(hex(a.promotion.promotionId)) ?? 0) + 1,
        );
      if (a.status === "confirmed" || a.status === "completed")
        visits.set(key, before + 1);
    }
    for (const p of await promotions.find({ tenantId: TENANT_ID }).toArray()) {
      expect(p.redemptions).toBe(used.get(hex(p._id)) ?? 0);
    }
    const demo = await users.findOne({
      tenantId: TENANT_ID,
      email: "cliente@montecobre.test",
    });
    expect((visits.get(hex(demo?._id ?? new ObjectId())) ?? 0) % 6).toBe(4);
  });

  test("every reference stays inside the showcase tenant", async () => {
    const inTenant = async (
      ids: ObjectId[],
      c: typeof users | typeof appointments | typeof barbers | typeof branches,
    ) => {
      const unique = [...new Map(ids.map((id) => [hex(id), id])).values()];
      expect(
        await c.countDocuments({ tenantId: TENANT_ID, _id: { $in: unique } }),
      ).toBe(unique.length);
    };
    const n = await notifications.find({ tenantId: TENANT_ID }).toArray();
    await inTenant(
      n.map((x) => x.appointmentId),
      appointments,
    );
    const w = await waitlist.find({ tenantId: TENANT_ID }).toArray();
    const o = await productOrders.find({ tenantId: TENANT_ID }).toArray();
    const receivers = o.flatMap((x) =>
      x.payment ? [x.payment.receivedBy] : [],
    );
    const customers = [...w, ...o].map((x) => x.customerId);
    await inTenant(
      [...n.map((x) => x.userId), ...customers, ...receivers],
      users,
    );
    const p = await payouts.find({ tenantId: TENANT_ID }).toArray();
    expect(p.length).toBeGreaterThan(0);
    for (const payout of p) {
      const settled = await appointments
        .find({ tenantId: TENANT_ID, _id: { $in: payout.appointmentIds } })
        .toArray();
      expect(
        settled.every((a: AppointmentDoc) => a.payoutId?.equals(payout._id)),
      ).toBe(true);
      expect(
        settled.reduce((s, a) => s + (a.commission?.amountMinor ?? 0), 0),
      ).toBe(payout.amountMinor);
    }
    const imgs = await images.find({ tenantId: TENANT_ID }).toArray();
    expect(imgs.every((i) => i.size <= 1024 * 1024)).toBe(true);
    const emails = (
      await users
        .find({ tenantId: TENANT_ID, email: { $exists: true } })
        .toArray()
    ).map((u) => u.email ?? "");
    expect(emails.every((e) => e.endsWith(".test"))).toBe(true);
  });

  test("refreshing to another day keeps stable collections and moves the agenda", async () => {
    const next = (
      await seedShowcase({ now: new Date(T.getTime() + DAY), shared: true })
    ).counts;
    const stable = (c: Counts) => [
      c.tenants,
      c.branches,
      c.users,
      c.barbers,
      c.services,
      c.packages,
      c.products,
      c.promotions,
      c.images,
    ];
    expect(stable(next)).toEqual(stable(first));
    expect(next.appointments).toBeGreaterThan(3000);
  });

  test("API smoke on montecobre.localhost", async () => {
    await seedShowcase({ now: T, shared: true });
    const login = async (email: string) => {
      const res = await api("POST", "/v1/auth/login", {
        host: HOST,
        body: { email, password: DEMO_PASSWORD },
      });
      expect(res.status).toBe(200);
      return { host: HOST, token: String(res.body.token) };
    };
    const customer = await login("cliente@montecobre.test");
    const loyalty = await api("GET", "/v1/me/loyalty", customer);
    expect(loyalty.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ everyVisits: 6, visits: 4 }),
      ]),
    );

    const owner = await login("owner@montecobre.test");
    const cash = await api("GET", `/v1/cash?date=${TODAY}`, owner);
    expect(cash.body.unrecorded).toBe(2);
    for (const branch of ["polanco", "providencia", "sanpedro"]) {
      const b = await branches.findOne({ tenantId: TENANT_ID, slug: branch });
      const res = await api(
        "GET",
        `/v1/cash?date=${TODAY}&branchId=${hex(b?._id ?? new ObjectId())}`,
        owner,
      );
      expect((res.body.people as unknown[]).length).toBeGreaterThanOrEqual(3);
    }
    const manager = await login("polanco@montecobre.test");
    expect(
      (await api("GET", `/v1/cash?date=${TODAY}`, manager)).body.unrecorded,
    ).toBe(1);

    const from = localDate(new Date(T.getTime() - 30 * DAY), ZONE);
    const summary = await api(
      "GET",
      `/v1/earnings/summary?from=${from}&to=${TODAY}`,
      owner,
    );
    expect(summary.body.servicesMinor).toBeGreaterThan(0);
    expect(summary.body.commissionMinor).toBeGreaterThan(0);
    const earnings = await api(
      "GET",
      `/v1/earnings?from=${from}&to=${TODAY}`,
      owner,
    );
    expect(earnings.body.total).toBeGreaterThanOrEqual(9);

    const list = await api("GET", "/v1/customers", owner);
    type Row = { guest: boolean; noShows: number; nextVisit?: string };
    const rows = list.body.customers as (Row & { name: string })[];
    expect(rows.length).toBe(50);
    expect(rows.some((r) => r.guest)).toBe(true);
    expect(rows.some((r) => r.noShows > 0)).toBe(true);
    expect(rows.some((r) => r.nextVisit)).toBe(true);
    expect(rows.some((r) => r.name === "Cliente eliminado")).toBe(false);

    const myDay = await api("GET", "/v1/appointments/my-day", owner);
    expect((myDay.body.barber as { name: string }).name).toBe("Ricardo Montes");
    const emilio = await login("emilio@montecobre.test");
    const day = await api("GET", "/v1/appointments/my-day", emilio);
    expect(day.status).toBe(200);
    expect(
      await api("POST", "/v1/auth/login", {
        host: HOST,
        body: { email: "owner@otra.test", password: DEMO_PASSWORD },
      }),
    ).toMatchObject({ status: 401 });
  });
});
