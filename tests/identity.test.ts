import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { migrateCustomers } from "../scripts/migrate-customers";
import { db } from "../src/db/client";
import { appointments, users } from "../src/db/collections";
import {
  api,
  bookingShop,
  createShop,
  dayIn,
  guestBooking,
  instantIn,
  nextPhone,
  PASSWORD,
  type Shop,
} from "./helpers";

const at = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);
const book = (shop: Shop, body: Record<string, unknown>, token?: string) =>
  api("POST", "/v1/public/appointments", { host: shop.host, token, body });
const ana = { name: "Ana", email: "ana@example.com", password: PASSWORD };

describe("one person, several barbershops", () => {
  test("accounts per barbershop are independent: same email, same or different password", async () => {
    const a = await createShop();
    const b = await createShop();
    const c = await createShop();
    const reg = (host: string, password: string) =>
      api("POST", "/v1/auth/register", { host, body: { ...ana, password } });
    const inA = await reg(a.host, PASSWORD);
    expect((await reg(b.host, PASSWORD)).status).toBe(201);
    expect((await reg(c.host, "another long password")).status).toBe(201);
    expect((await reg(a.host, PASSWORD)).status).toBe(409);

    const login = (host: string, password: string) =>
      api("POST", "/v1/auth/login", {
        host,
        body: { email: ana.email, password },
      });
    expect((await login(c.host, "another long password")).status).toBe(200);
    expect((await login(c.host, PASSWORD)).status).toBe(401);
    // A session of one barbershop is worthless in another.
    const me = await api("GET", "/v1/auth/me", {
      host: b.host,
      token: String(inA.body.token),
    });
    expect(me.status).toBe(401);
    expect(
      await users.countDocuments({ email: ana.email }),
    ).toBeGreaterThanOrEqual(3);
  });

  test("a guest is never matched to an account by phone or email", async () => {
    const shop = await bookingShop();
    const phone = nextPhone();
    const signup = await api("POST", "/v1/auth/register", {
      host: shop.host,
      body: { ...ana, phone },
    });
    const token = String(signup.body.token);
    // Someone books as a guest with the account holder's phone and email.
    const guestRes = await book(
      shop,
      guestBooking(at(shop, 2, "11:00"), {
        customer: { name: "Intruso", phone, email: ana.email },
      }),
    );
    expect(guestRes.status).toBe(201);
    const mine = await api("GET", "/v1/me/appointments", {
      host: shop.host,
      token,
    });
    expect(Object.values(mine.body)).toEqual([]);

    const guest = await users.findOne({
      tenantId: shop.tenant._id,
      guest: true,
      phone,
    });
    expect(guest).toMatchObject({
      role: "customer",
      name: "Intruso",
      contactEmail: ana.email,
    });
    expect(guest?.email).toBeUndefined();
    expect(guest?.passwordHash).toBeUndefined();

    // The account books under its own id, and the guest's email never blocks signing in or up.
    const own = await book(
      shop,
      guestBooking(at(shop, 2, "15:00"), { customer: undefined }),
      token,
    );
    expect(own.status).toBe(201);
    const stored = await appointments.findOne({
      _id: new ObjectId(String(own.body.id)),
    });
    expect(stored?.customerId.toHexString()).toBe(
      String(signup.body.user && (signup.body.user as { id: string }).id),
    );
    const login = await api("POST", "/v1/auth/login", {
      host: shop.host,
      body: { email: ana.email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
  });

  test("a guest record can't sign in and is not listed as staff", async () => {
    const shop = await bookingShop();
    await book(shop, guestBooking(at(shop, 2, "11:00")));
    const list = await api("GET", "/v1/users", shop.asOwner);
    expect(
      (list.body as unknown as { role: string }[]).map((u) => u.role),
    ).toEqual(["owner"]);
    const login = await api("POST", "/v1/auth/login", {
      host: shop.host,
      body: { email: "nobody@example.com", password: PASSWORD },
    });
    expect(login.status).toBe(401);
  });

  test("the database refuses a second guest with the same phone and an account without credentials", async () => {
    const shop = await createShop();
    const now = new Date();
    const guest = () => ({
      _id: new ObjectId(),
      tenantId: shop.tenant._id,
      role: "customer" as const,
      guest: true as const,
      active: true,
      name: "G",
      phone: "+526641234567",
      createdAt: now,
      updatedAt: now,
    });
    await users.insertOne(guest());
    await expect(users.insertOne(guest())).rejects.toThrow();
    await expect(
      users.insertOne({ ...guest(), phone: "+526641234568", guest: undefined }),
    ).rejects.toThrow();
  });
});

describe("customers → users migration", () => {
  test("keeps every appointment, never merges accounts, and is idempotent", async () => {
    const shop = await createShop();
    const other = await createShop();
    const now = new Date();
    const legacy = db.collection("customers");
    const account = await api("POST", "/v1/auth/register", {
      host: shop.host,
      body: { ...ana, phone: "+526641110000" },
    });
    const accountId = new ObjectId((account.body.user as { id: string }).id);
    // Another account (other tenant) with the same email must stay untouched.
    const twin = await api("POST", "/v1/auth/register", {
      host: other.host,
      body: ana,
    });
    const twinId = new ObjectId((twin.body.user as { id: string }).id);

    const linked = {
      _id: new ObjectId(),
      tenantId: shop.tenant._id,
      userId: accountId,
      name: "Ana",
      phone: "+526641110000",
      stripeCustomerId: "cus_abc",
      createdAt: now,
      updatedAt: now,
    };
    const guest = {
      _id: new ObjectId(),
      tenantId: shop.tenant._id,
      name: "Beto",
      phone: "+526641110001",
      email: "beto@example.com",
      createdAt: now,
      updatedAt: now,
    };
    const orphan = {
      _id: new ObjectId(),
      tenantId: shop.tenant._id,
      userId: new ObjectId(),
      name: "Cata",
      createdAt: now,
      updatedAt: now,
    };
    await legacy.insertMany([linked, guest, orphan]);

    const startAt = new Date(Date.now() + 864e5);
    const seed = async (customerId: ObjectId, tenantId = shop.tenant._id) => {
      const id = new ObjectId();
      await appointments.insertOne({
        _id: id,
        tenantId,
        branchId: new ObjectId(),
        barberId: new ObjectId(),
        customerId,
        status: "completed",
        startAt,
        endAt: new Date(startAt.getTime() + 45 * 60_000),
        blockedUntil: new Date(startAt.getTime() + 45 * 60_000),
        timeZone: "UTC",
        items: [
          {
            kind: "service",
            serviceId: new ObjectId(),
            name: { es: "c" },
            durationMin: 45,
            priceMinor: 100,
          },
        ],
        currency: "MXN",
        subtotalMinor: 100,
        discountMinor: 0,
        totalMinor: 100,
        source: "online",
        createdAt: now,
        updatedAt: now,
      });
      return id;
    };
    const ofLinked = await seed(linked._id);
    const ofGuest = await seed(guest._id);
    const ofOrphan = await seed(orphan._id);

    const dry = await migrateCustomers(false);
    expect(dry).toMatchObject({ linked: 1, guests: 2 });
    expect((await appointments.findOne({ _id: ofLinked }))?.customerId).toEqual(
      linked._id,
    );
    expect(
      await users.countDocuments({ guest: true, tenantId: shop.tenant._id }),
    ).toBe(0);

    const report = await migrateCustomers(true);
    expect(report).toMatchObject({
      linked: 1,
      guests: 2,
      appointmentsRemapped: 1,
    });
    expect((await appointments.findOne({ _id: ofLinked }))?.customerId).toEqual(
      accountId,
    );
    expect((await appointments.findOne({ _id: ofGuest }))?.customerId).toEqual(
      guest._id,
    );
    expect((await appointments.findOne({ _id: ofOrphan }))?.customerId).toEqual(
      orphan._id,
    );

    expect(await users.findOne({ _id: guest._id })).toMatchObject({
      guest: true,
      role: "customer",
      contactEmail: "beto@example.com",
      phone: guest.phone,
    });
    expect(await users.findOne({ _id: accountId })).toMatchObject({
      stripeCustomerId: "cus_abc",
      legacyCustomerId: linked._id,
    });
    // The other barbershop's account is a different person as far as we can verify.
    expect(await users.findOne({ _id: twinId })).not.toHaveProperty(
      "legacyCustomerId",
    );
    expect(await legacy.countDocuments({ tenantId: shop.tenant._id })).toBe(3);

    const again = await migrateCustomers(true);
    expect(again).toMatchObject({ appointmentsRemapped: 0 });
    expect(
      await users.countDocuments({ tenantId: shop.tenant._id, guest: true }),
    ).toBe(2);
  });
});
