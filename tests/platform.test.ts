import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/app";
import {
  type AppointmentDoc,
  appointments,
  barbers,
  platformStaff,
} from "../src/db/collections";
import { platformLogin } from "../src/features/platform/auth";
import { api, bookingShop, createShop, createUser } from "./helpers";

const PASSWORD = "correct horse battery";

async function createStaff(active = true) {
  const email = `staff-${new ObjectId().toHexString()}@example.com`;
  const now = new Date();
  await platformStaff.insertOne({
    _id: new ObjectId(),
    email,
    name: "Staff",
    passwordHash: await Bun.password.hash(PASSWORD, {
      algorithm: "argon2id",
      memoryCost: 1024,
      timeCost: 1,
    }),
    active,
    createdAt: now,
    updatedAt: now,
  });
  return {
    email,
    token: active ? (await platformLogin(email, PASSWORD)).token : "",
  };
}

const call = async (
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) => {
  const res = await app.request(path, {
    method,
    headers: {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as any };
};

const day = new Date().toISOString().slice(0, 10);
const range = `from=${day}&to=${day}`;

async function seedAppointment(
  tenantId: ObjectId,
  branchId: ObjectId,
  barberId: ObjectId,
  overrides: Partial<AppointmentDoc> = {},
) {
  const startAt = new Date(`${day}T17:00:00Z`);
  const doc: AppointmentDoc = {
    _id: new ObjectId(),
    tenantId,
    branchId,
    barberId,
    customerId: new ObjectId(),
    status: "completed",
    startAt,
    endAt: new Date(startAt.getTime() + 45 * 60_000),
    blockedUntil: new Date(startAt.getTime() + 45 * 60_000),
    timeZone: "UTC",
    items: [
      {
        kind: "service",
        serviceId: new ObjectId(),
        name: { es: "Corte" },
        durationMin: 45,
        priceMinor: 30_000,
      },
    ],
    currency: "MXN",
    subtotalMinor: 30_000,
    discountMinor: 0,
    totalMinor: 30_000,
    source: "staff",
    createdAt: startAt,
    updatedAt: startAt,
    ...overrides,
  };
  await appointments.insertOne(doc);
  return doc;
}

describe("platform staff access", () => {
  test("only platform staff get in: no token, a tenant owner's token and a disabled account are all refused", async () => {
    const shop = await createShop();
    const staff = await createStaff();
    expect((await call("GET", `/platform/summary?${range}`)).status).toBe(401);
    expect(
      (await call("GET", `/platform/summary?${range}`, shop.owner.token))
        .status,
    ).toBe(401);
    expect(
      (await call("GET", `/platform/summary?${range}`, staff.token)).status,
    ).toBe(200);
    await platformStaff.updateOne(
      { email: staff.email },
      { $set: { active: false } },
    );
    expect(
      (await call("GET", `/platform/summary?${range}`, staff.token)).status,
    ).toBe(401);
  });

  test("platform tokens do not work as tenant sessions, and login rejects bad passwords", async () => {
    const shop = await createShop();
    const staff = await createStaff();
    expect(
      (await api("GET", "/v1/auth/me", { host: shop.host, token: staff.token }))
        .status,
    ).toBe(401);
    const bad = await call("POST", "/platform/auth/login", undefined, {
      email: staff.email,
      password: "wrong password!",
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("INVALID_CREDENTIALS");
    const ok = await call("POST", "/platform/auth/login", undefined, {
      email: staff.email,
      password: PASSWORD,
    });
    expect(ok.status).toBe(200);
  });
});

describe("platform finances", () => {
  test("separates sales, collected money, accrued commission and payouts; never double counts", async () => {
    const shop = await bookingShop();
    const branchId = new ObjectId(shop.branchId);
    const barberId = new ObjectId(shop.barbers.mateo);
    const staff = await createStaff();
    const q = `${range}&tenantId=${shop.tenant._id}`;

    // Completed, paid online; completed in person; cancelled (earns nothing).
    const paid = await seedAppointment(shop.tenant._id, branchId, barberId, {
      payment: {
        provider: "stripe",
        intentId: "pi_test1",
        status: "paid",
        amountMinor: 30_000,
      },
    });
    const walkIn = await seedAppointment(shop.tenant._id, branchId, barberId, {
      totalMinor: 20_000,
      subtotalMinor: 20_000,
    });
    await seedAppointment(shop.tenant._id, branchId, barberId, {
      status: "cancelled",
    });

    // No rate configured: the money is reported, the commission is not invented.
    let summary = await call("GET", `/platform/summary?${q}`, staff.token);
    expect(summary.body).toHaveLength(1);
    expect(summary.body[0]).toMatchObject({
      currency: "MXN",
      completed: 2,
      cancelled: 1,
      sales: 50_000,
      collected: 30_000,
      avgTicket: 25_000,
      commission: 0,
      unconfigured: 2,
    });
    const unpaid = await call("POST", "/platform/payouts", staff.token, {
      barberId: String(barberId),
      appointmentIds: [String(paid._id)],
    });
    expect(unpaid.status).toBe(409);
    expect(unpaid.body.error.code).toBe("COMMISSION_NOT_CONFIGURED");

    // Configure 40%.
    expect(
      (
        await call(
          "PATCH",
          `/platform/barbers/${barberId}/commission`,
          staff.token,
          {
            commissionBps: 4_000,
          },
        )
      ).status,
    ).toBe(204);
    summary = await call("GET", `/platform/summary?${q}`, staff.token);
    expect(summary.body[0]).toMatchObject({
      commission: 20_000,
      paidOut: 0,
      pending: 20_000,
      unconfigured: 0,
    });

    // Pay one appointment; the other stays pending; paying it again is refused.
    const payout = await call("POST", "/platform/payouts", staff.token, {
      barberId: String(barberId),
      appointmentIds: [String(paid._id), String(paid._id)],
      reference: "SPEI 123",
    });
    expect(payout.status).toBe(201);
    expect(payout.body).toMatchObject({ amountMinor: 12_000, appointments: 1 });
    const again = await call("POST", "/platform/payouts", staff.token, {
      barberId: String(barberId),
      appointmentIds: [String(paid._id), String(walkIn._id)],
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_PAID");
    summary = await call("GET", `/platform/summary?${q}`, staff.token);
    expect(summary.body[0]).toMatchObject({
      commission: 20_000,
      paidOut: 12_000,
      pending: 8_000,
    });

    // A later rate change leaves what was frozen at payout alone.
    await call(
      "PATCH",
      `/platform/barbers/${barberId}/commission`,
      staff.token,
      {
        commissionBps: 1_000,
      },
    );
    const detail = await call(
      "GET",
      `/platform/appointments/${paid._id}`,
      staff.token,
    );
    expect(detail.body.commission).toMatchObject({
      state: "paid",
      bps: 4_000,
      baseMinor: 30_000,
      amountMinor: 12_000,
      source: "snapshot",
    });
    expect(detail.body.payout).toMatchObject({
      amountMinor: 12_000,
      reference: "SPEI 123",
    });
    const open = await call(
      "GET",
      `/platform/appointments/${walkIn._id}`,
      staff.token,
    );
    expect(open.body.commission).toMatchObject({
      state: "accrued",
      bps: 1_000,
      amountMinor: 2_000,
      source: "barber_config",
    });

    // Per-barber earnings for the day, and the paginated list.
    const earnings = await call(
      "GET",
      `/platform/breakdown?by=barber&${q}`,
      staff.token,
    );
    expect(earnings.body.rows[0]).toMatchObject({
      id: String(barberId),
      completed: 2,
      sales: 50_000,
      commission: 14_000,
      paidOut: 12_000,
      pending: 2_000,
      commissionBps: 1_000,
    });
    const list = await call(
      "GET",
      `/platform/appointments?${q}&limit=2`,
      staff.token,
    );
    expect(list.body.total).toBe(3);
    expect(list.body.rows).toHaveLength(2);
    const onlyCancelled = await call(
      "GET",
      `/platform/appointments?${q}&status=cancelled`,
      staff.token,
    );
    expect(onlyCancelled.body.total).toBe(1);
    expect(onlyCancelled.body.rows[0].commission.state).toBe("not_applicable");
  });

  test("completing through the tenant API freezes the commission at that moment", async () => {
    const shop = await bookingShop();
    const staff = await createStaff();
    const barberId = new ObjectId(shop.barbers.mateo);
    await barbers.updateOne(
      { _id: barberId },
      { $set: { commissionBps: 5_000 } },
    );
    const startAt = new Date(Date.now() - 3 * 3_600_000);
    const past = await seedAppointment(
      shop.tenant._id,
      new ObjectId(shop.branchId),
      barberId,
      {
        status: "confirmed",
        startAt,
        endAt: new Date(startAt.getTime() + 45 * 60_000),
        blockedUntil: new Date(startAt.getTime() + 45 * 60_000),
      },
    );
    const done = await api("PATCH", `/v1/appointments/${past._id}`, {
      ...shop.asOwner,
      body: { status: "completed" },
    });
    expect(done.status).toBe(200);
    await barbers.updateOne(
      { _id: barberId },
      { $set: { commissionBps: 1_000 } },
    );
    const detail = await call(
      "GET",
      `/platform/appointments/${past._id}`,
      staff.token,
    );
    expect(detail.body.commission).toMatchObject({
      bps: 5_000,
      amountMinor: 15_000,
      source: "snapshot",
    });
  });

  test("a barber of another tenant can't be paid with someone else's appointments", async () => {
    const a = await bookingShop();
    const b = await bookingShop();
    const staff = await createStaff();
    const barberA = new ObjectId(a.barbers.mateo);
    const barberB = new ObjectId(b.barbers.mateo);
    await barbers.updateOne(
      { _id: barberB },
      { $set: { commissionBps: 1_000 } },
    );
    const appointment = await seedAppointment(
      a.tenant._id,
      new ObjectId(a.branchId),
      barberA,
    );
    const res = await call("POST", "/platform/payouts", staff.token, {
      barberId: String(barberB),
      appointmentIds: [String(appointment._id)],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INVALID_APPOINTMENTS");
  });

  test("dates are the branch's local day, and ranges are validated", async () => {
    const shop = await bookingShop();
    const staff = await createStaff();
    // 02:00 UTC is still the previous evening in Tijuana.
    const early = new Date(`${day}T02:00:00Z`);
    await seedAppointment(
      shop.tenant._id,
      new ObjectId(shop.branchId),
      new ObjectId(shop.barbers.mateo),
      {
        startAt: early,
        endAt: new Date(early.getTime() + 45 * 60_000),
        blockedUntil: new Date(early.getTime() + 45 * 60_000),
        timeZone: "America/Tijuana",
      },
    );
    const previous = new Date(Date.parse(`${day}T00:00:00Z`) - 864e5)
      .toISOString()
      .slice(0, 10);
    const q = `tenantId=${shop.tenant._id}`;
    const onDay = await call(
      "GET",
      `/platform/summary?${range}&${q}`,
      staff.token,
    );
    expect(onDay.body).toEqual([]);
    const before = await call(
      "GET",
      `/platform/summary?from=${previous}&to=${previous}&${q}`,
      staff.token,
    );
    expect(before.body[0].completed).toBe(1);
    expect(
      (
        await call(
          "GET",
          `/platform/summary?from=${day}&to=2000-01-01`,
          staff.token,
        )
      ).status,
    ).toBe(422);
  });

  test("tenant filter really scopes the numbers", async () => {
    const a = await bookingShop();
    const b = await bookingShop();
    const staff = await createStaff();
    await seedAppointment(
      a.tenant._id,
      new ObjectId(a.branchId),
      new ObjectId(a.barbers.mateo),
    );
    await seedAppointment(
      b.tenant._id,
      new ObjectId(b.branchId),
      new ObjectId(b.barbers.mateo),
    );
    const onlyA = await call(
      "GET",
      `/platform/summary?${range}&tenantId=${a.tenant._id}`,
      staff.token,
    );
    expect(onlyA.body[0].completed).toBe(1);
    const tenants = await call(
      "GET",
      `/platform/breakdown?by=tenant&${range}&tenantId=${b.tenant._id}`,
      staff.token,
    );
    expect(tenants.body.rows).toHaveLength(1);
    expect(tenants.body.rows[0].id).toBe(String(b.tenant._id));
  });
});

describe("earnings in the barbershop's own admin", () => {
  test("owner sets rates and pays only their own barbers; managers and other shops are refused", async () => {
    const a = await bookingShop();
    const b = await bookingShop();
    const barber = new ObjectId(a.barbers.mateo);
    const appt = await seedAppointment(
      a.tenant._id,
      new ObjectId(a.branchId),
      barber,
    );
    const q = `from=${day}&to=${day}`;

    const rows = await api("GET", `/v1/earnings?${q}`, a.asOwner);
    expect(rows.status).toBe(200);
    expect((rows.body.rows as { id: string }[]).map((r) => r.id)).toContain(
      a.barbers.mateo,
    );
    // Asking for another tenant changes nothing: the tenant comes from the session.
    const spoof = await api(
      "GET",
      `/v1/earnings?${q}&tenantId=${b.tenant._id}`,
      a.asOwner,
    );
    expect(
      (spoof.body.rows as { id: string }[]).every(
        (r) => r.id !== b.barbers.mateo,
      ),
    ).toBe(true);

    const manager = await createUser(a.tenant, "manager", {
      branchId: new ObjectId(a.branchId),
    });
    expect(
      (
        await api("GET", `/v1/earnings?${q}`, {
          host: a.host,
          token: manager.token,
        })
      ).status,
    ).toBe(403);

    const body = {
      barberId: a.barbers.mateo,
      appointmentIds: [String(appt._id)],
    };
    expect(
      (await api("POST", "/v1/earnings/payouts", { ...a.asOwner, body })).body
        .error?.code,
    ).toBe("COMMISSION_NOT_CONFIGURED");
    expect(
      (
        await api("PATCH", `/v1/earnings/barbers/${a.barbers.mateo}`, {
          ...a.asOwner,
          body: { commissionBps: 2_500 },
        })
      ).status,
    ).toBe(204);
    // Another shop's owner can't touch this barber.
    expect(
      (
        await api("PATCH", `/v1/earnings/barbers/${a.barbers.mateo}`, {
          ...b.asOwner,
          body: { commissionBps: 9_000 },
        })
      ).status,
    ).toBe(404);
    expect(
      (await api("POST", "/v1/earnings/payouts", { ...b.asOwner, body }))
        .status,
    ).toBe(404);
    const paid = await api("POST", "/v1/earnings/payouts", {
      ...a.asOwner,
      body,
    });
    expect(paid.status).toBe(201);
    expect(paid.body.amountMinor).toBe(7_500);
    expect(
      (await api("POST", "/v1/earnings/payouts", { ...a.asOwner, body })).body
        .error?.code,
    ).toBe("ALREADY_PAID");
  });
});
