import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  appointments,
  type TenantDoc,
  users,
} from "../src/db/collections";
import { hit } from "../src/db/rate-limit";
import { addBranch, api, createShop, createUser, PASSWORD } from "./helpers";
import { fakeStripe } from "./stripe-fake";

const DAY = 864e5;

async function visit(
  tenant: TenantDoc,
  branchId: string,
  customerId: ObjectId,
  status: AppointmentDoc["status"],
  daysFromNow: number,
  totalMinor = 30_000,
) {
  const startAt = new Date(Date.now() + daysFromNow * DAY);
  const endAt = new Date(startAt.getTime() + 45 * 60_000);
  await appointments.insertOne({
    _id: new ObjectId(),
    tenantId: tenant._id,
    branchId: new ObjectId(branchId),
    barberId: new ObjectId(),
    customerId,
    status,
    startAt,
    endAt,
    blockedUntil: endAt,
    timeZone: "UTC",
    items: [
      {
        kind: "service",
        serviceId: new ObjectId(),
        name: { es: "Corte" },
        durationMin: 45,
        priceMinor: totalMinor,
      },
    ],
    currency: "MXN",
    subtotalMinor: totalMinor,
    discountMinor: 0,
    totalMinor,
    source: "staff",
    createdAt: startAt,
    updatedAt: startAt,
  });
  return startAt.toISOString().slice(0, 10);
}

async function guest(tenant: TenantDoc, name: string, phone: string) {
  const now = new Date();
  const _id = new ObjectId();
  await users.insertOne({
    _id,
    tenantId: tenant._id,
    name,
    phone,
    guest: true,
    role: "customer",
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  return _id;
}

type Listed = {
  id: string;
  name: string;
  guest: boolean;
  visits: number;
  noShows: number;
  spentMinor: number;
  lastVisit?: string;
  nextVisit?: string;
};
const listed = (body: Record<string, unknown>) =>
  body.customers as unknown as Listed[];

describe("customer list", () => {
  test("owners see each customer's visits, misses, spend, last and next visit", async () => {
    const { tenant, branchId, asOwner } = await createShop();
    const ana = await createUser(tenant, "customer", {
      name: "Ana López",
      phone: "+526641110000",
    });
    await visit(tenant, branchId, ana.user._id, "completed", -40, 25_000);
    const last = await visit(tenant, branchId, ana.user._id, "completed", -3);
    await visit(tenant, branchId, ana.user._id, "no_show", -10);
    await visit(tenant, branchId, ana.user._id, "cancelled", -2);
    const next = await visit(tenant, branchId, ana.user._id, "confirmed", 5);
    await guest(tenant, "Luis Pérez", "+526642220000");

    const res = await api("GET", "/v1/customers", asOwner);
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("MXN");
    const [luis, anaRow] = listed(res.body);
    expect(luis).toMatchObject({ name: "Luis Pérez", guest: true, visits: 0 });
    expect(anaRow).toMatchObject({
      id: ana.user._id.toHexString(),
      name: "Ana López",
      phone: "+526641110000",
      guest: false,
      visits: 2,
      noShows: 1,
      spentMinor: 55_000,
      lastVisit: last,
      nextVisit: next,
    });
  });

  test("searches by name, email or phone digits; staff and other shops never show up", async () => {
    const { tenant, asOwner } = await createShop();
    const other = await createShop();
    await createUser(tenant, "customer", {
      name: "Ana López",
      email: "ana.lopez@example.com",
      phone: "+526641110000",
    });
    await guest(tenant, "Luis Pérez", "+526642220000");
    await createUser(other.tenant, "customer", { name: "Ana Otra" });
    await createUser(tenant, "barber", { name: "Ana Barbera" });

    const names = async (q: string) =>
      listed(
        (await api("GET", `/v1/customers?q=${encodeURIComponent(q)}`, asOwner))
          .body,
      ).map((c) => c.name);
    expect(await names("ana")).toEqual(["Ana López"]);
    expect(await names("LOPEZ@EXAMPLE")).toEqual(["Ana López"]);
    expect(await names("664 222")).toEqual(["Luis Pérez"]);
    expect(await names("(.*)")).toEqual([]);
  });

  test("a manager's numbers only count their branch; barbers and customers can't list", async () => {
    const { tenant, host, owner, branchId } = await createShop();
    const otherBranch = await addBranch(host, owner.token);
    const ana = await createUser(tenant, "customer", { name: "Ana" });
    await visit(tenant, branchId, ana.user._id, "completed", -3);
    await visit(tenant, otherBranch, ana.user._id, "completed", -2);
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });

    const res = await api("GET", "/v1/customers", {
      host,
      token: manager.token,
    });
    expect(listed(res.body)[0]).toMatchObject({ name: "Ana", visits: 1 });

    for (const role of ["barber", "customer"] as const) {
      const { token } = await createUser(tenant, role);
      expect((await api("GET", "/v1/customers", { host, token })).status).toBe(
        403,
      );
    }
  });
});

describe("customer list scoping and rate limit", () => {
  test("a manager only sees customers who booked at their branch; the owner sees everyone", async () => {
    const { tenant, host, owner, branchId, asOwner } = await createShop();
    const otherBranch = await addBranch(host, owner.token);
    const ana = await createUser(tenant, "customer", { name: "Ana" });
    const beto = await createUser(tenant, "customer", { name: "Beto" });
    await guest(tenant, "Carla", "+526643330000");
    await visit(tenant, branchId, ana.user._id, "completed", -3);
    await visit(tenant, otherBranch, beto.user._id, "completed", -2);
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const asManager = { host, token: manager.token };
    const names = async (as: typeof asManager, q = "") =>
      listed(
        (
          await api(
            "GET",
            `/v1/customers${q && `?q=${encodeURIComponent(q)}`}`,
            as,
          )
        ).body,
      )
        .map((c) => c.name)
        .toSorted();

    expect(await names(asManager)).toEqual(["Ana"]);
    expect(await names(asManager, "beto")).toEqual([]);
    expect(await names(asOwner)).toEqual(["Ana", "Beto", "Carla"]);
  });

  test("too many searches answer 429 RATE_LIMITED", async () => {
    const { tenant, host } = await createShop();
    const admin = await createUser(tenant, "admin");
    for (let i = 0; i < 60; i++) {
      await hit(`customers:${admin.user._id.toHexString()}`, 60, 600_000);
    }
    const res = await api("GET", "/v1/customers?q=ana", {
      host,
      token: admin.token,
    });
    expect(res.status).toBe(429);
    expect(res.body.error?.code).toBe("RATE_LIMITED");
  });
});

describe("customer deletes their account", () => {
  test("asks for the password and waits for open visits, then erases contact data and login", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const email = `ana-${new ObjectId().toHexString()}@example.com`;
    const ana = await createUser(tenant, "customer", {
      name: "Ana López",
      email,
      phone: "+526641110000",
    });
    const me = { host, token: ana.token };
    await visit(tenant, branchId, ana.user._id, "completed", -3);
    await visit(tenant, branchId, ana.user._id, "confirmed", 2);

    const erase = (password: string) =>
      api("POST", "/v1/auth/delete-account", { ...me, body: { password } });
    expect((await erase("wrong password")).status).toBe(403);
    const open = await erase(PASSWORD);
    expect(open.status).toBe(409);
    expect(open.body.error?.code).toBe("OPEN_BOOKINGS");

    await appointments.updateMany(
      { customerId: ana.user._id, status: "confirmed" },
      { $set: { status: "cancelled" } },
    );
    expect((await erase(PASSWORD)).status).toBe(204);

    expect((await api("GET", "/v1/auth/me", me)).status).toBe(401);
    const login = await api("POST", "/v1/auth/login", {
      host,
      body: { email, password: PASSWORD },
    });
    expect(login.status).toBe(401);

    const erased = await users.findOne({ _id: ana.user._id });
    expect(erased).toMatchObject({ name: "Cliente eliminado", active: false });
    expect(erased?.deletedAt).toBeInstanceOf(Date);
    for (const field of ["email", "phone", "passwordHash"] as const) {
      expect(erased?.[field]).toBeUndefined();
    }
    expect(
      await appointments.countDocuments({ customerId: ana.user._id }),
    ).toBe(2);
    expect(listed((await api("GET", "/v1/customers", asOwner)).body)).toEqual(
      [],
    );

    const again = await api("POST", "/v1/auth/register", {
      host,
      body: { name: "Ana López", email, password: PASSWORD, acceptTerms: true },
    });
    expect(again.status).toBe(201);
  });

  test("corrects their own name and phone, and Stripe's copy first", async () => {
    const { tenant, host, asOwner } = await createShop();
    const ana = await createUser(tenant, "customer", {
      name: "Ana Lopes",
      phone: "+526641110000",
    });
    const me = { host, token: ana.token };
    const edit = (body: Record<string, unknown>) =>
      api("PATCH", "/v1/auth/me", { ...me, body });

    const fixed = await edit({ name: "Ana López", phone: "(664) 222-0000" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.user).toMatchObject({
      name: "Ana López",
      phone: "6642220000",
    });
    expect(listed((await api("GET", "/v1/customers", asOwner)).body)).toEqual([
      expect.objectContaining({ name: "Ana López", phone: "6642220000" }),
    ]);

    const cleared = await edit({ name: "Ana López", phone: "" });
    expect(cleared.body.user).not.toHaveProperty("phone");
    expect((await users.findOne({ _id: ana.user._id }))?.phone).toBeUndefined();

    expect((await edit({ name: "A", phone: "" })).status).toBe(422);
    expect(
      (await edit({ name: "Ana", phone: "", email: "x@y.z" })).status,
    ).toBe(422);
    const staff = await api("PATCH", "/v1/auth/me", {
      host,
      token: asOwner.token,
      body: { name: "Dueño", phone: "" },
    });
    expect(staff.status).toBe(403);

    const stripe = fakeStripe();
    try {
      await users.updateOne(
        { _id: ana.user._id },
        { $set: { stripeCustomerId: "cus_ana" } },
      );
      stripe.state.down = true;
      expect((await edit({ name: "Ana María", phone: "" })).status).toBe(502);
      expect((await users.findOne({ _id: ana.user._id }))?.name).toBe(
        "Ana López",
      );
      stripe.state.down = false;
      expect((await edit({ name: "Ana María", phone: "" })).status).toBe(200);
      expect(stripe.calls).toContainEqual({
        method: "POST",
        path: "/v1/customers/cus_ana",
      });
    } finally {
      stripe.restore();
    }
  });

  test("staff can't erase their own account", async () => {
    const { host, owner } = await createShop();
    const res = await api("POST", "/v1/auth/delete-account", {
      host,
      token: owner.token,
      body: { password: PASSWORD },
    });
    expect(res.status).toBe(403);
  });
});
