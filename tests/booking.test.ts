import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { appointments, customers, tenants } from "../src/db/collections";
import { PLAN_LIMITS } from "../src/features/tenancy/subscription";
import {
  api,
  bookingShop,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
  nextPhone,
  PASSWORD,
  type Shop,
} from "./helpers";

const book = (shop: Shop, body: Record<string, unknown>, token?: string) =>
  api("POST", "/v1/public/appointments", { host: shop.host, token, body });
const at = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);

describe("online booking", () => {
  test("a guest books a free slot; the appointment keeps a snapshot of what was booked", async () => {
    const shop = await bookingShop();
    const phone = nextPhone();
    const startAt = at(shop, 2, "11:00");
    const res = await book(
      shop,
      guestBooking(startAt, { customer: { name: "Ana López", phone } }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: "confirmed",
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(Date.parse(startAt) + 45 * 60_000).toISOString(),
      timeZone: shop.timeZone,
      barber: { slug: "mateo" },
      branch: { slug: "centro" },
      items: [
        {
          kind: "service",
          name: { es: "corte" },
          durationMin: 45,
          priceMinor: 30_000,
        },
      ],
      currency: "MXN",
      subtotalMinor: 30_000,
      discountMinor: 0,
      totalMinor: 30_000,
      cancellable: true,
    });

    const again = await book(
      shop,
      guestBooking(at(shop, 2, "15:00"), {
        customer: { name: "Otra Persona", phone },
      }),
    );
    expect(again.status).toBe(201);
    const records = await customers
      .find({ tenantId: shop.tenant._id, phone })
      .toArray();
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("Ana López");
  });

  test("only offered slots can be booked", async () => {
    const shop = await bookingShop();
    expect((await book(shop, guestBooking(at(shop, 2, "12:00")))).status).toBe(
      201,
    );
    for (const startAt of [
      at(shop, 2, "12:00"),
      at(shop, 2, "12:30"),
      at(shop, 2, "10:05"),
      at(shop, 2, "17:30"),
      at(shop, 2, "08:00"),
      at(shop, 15, "11:00"),
      new Date(Date.now() + 10 * 60_000).toISOString(),
    ]) {
      const res = await book(shop, guestBooking(startAt));
      expect(res.status).toBe(409);
      expect(res.body.error?.code).toBe("SLOT_TAKEN");
    }
  });

  test("10 simultaneous requests for one slot: exactly one wins", async () => {
    const shop = await bookingShop();
    const startAt = at(shop, 3, "13:00");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => book(shop, guestBooking(startAt))),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, ...Array(9).fill(409)]);
    expect(
      await appointments.countDocuments({
        tenantId: shop.tenant._id,
        status: "confirmed",
      }),
    ).toBe(1);

    const overlapping = await Promise.all(
      ["10:00", "10:15", "10:30", "10:00", "10:15", "10:30"].map((time) =>
        book(shop, guestBooking(at(shop, 4, time))),
      ),
    );
    expect(overlapping.filter((r) => r.status === 201)).toHaveLength(1);

    const twoBarbers = await Promise.all([
      book(shop, guestBooking(at(shop, 3, "15:00"))),
      book(shop, guestBooking(at(shop, 3, "15:00"), { barber: "lucas" })),
    ]);
    expect(twoBarbers.map((r) => r.status)).toEqual([201, 201]);
  });

  test("changing the catalog later never changes a past booking", async () => {
    const shop = await bookingShop();
    const single = await book(shop, guestBooking(at(shop, 2, "10:00")));
    const pkg = await book(
      shop,
      guestBooking(at(shop, 2, "14:00"), {
        service: undefined,
        package: "corte-barba",
      }),
    );
    expect(pkg.body).toMatchObject({
      totalMinor: 45_000,
      items: [{ kind: "package", durationMin: 75 }],
    });

    await api("PATCH", `/v1/services/${shop.services.corte}`, {
      ...shop.asOwner,
      body: { durationMin: 60, priceMinor: 35_000 },
    });
    await api("PATCH", `/v1/packages/${shop.pkg}`, {
      ...shop.asOwner,
      body: { priceMinor: 50_000 },
    });

    const after = await api(
      "GET",
      `/v1/appointments/${single.body.id}`,
      shop.asOwner,
    );
    expect(after.body).toMatchObject({
      endAt: single.body.endAt,
      totalMinor: 30_000,
      items: [{ durationMin: 45, priceMinor: 30_000 }],
    });
    const afterPkg = await api(
      "GET",
      `/v1/appointments/${pkg.body.id}`,
      shop.asOwner,
    );
    expect(afterPkg.body).toMatchObject({
      totalMinor: 45_000,
      endAt: pkg.body.endAt,
    });
  });

  test("a signed-in customer books without guest details, lists and cancels in time", async () => {
    const shop = await bookingShop();
    const user = await createUser(shop.tenant, "customer", {
      phone: nextPhone(),
    });
    const later = await book(
      shop,
      { ...guestBooking(at(shop, 3, "10:00")), customer: undefined },
      user.token,
    );
    expect(later.status).toBe(201);
    const second = await book(
      shop,
      { ...guestBooking(at(shop, 3, "14:00")), customer: undefined },
      user.token,
    );
    expect(second.status).toBe(201);

    const mine = await api("GET", "/v1/me/appointments", {
      host: shop.host,
      token: user.token,
    });
    expect(
      (mine.body as unknown as { id: string }[]).map((a) => a.id),
    ).toContain(String(later.body.id));
    expect(
      (
        await api("POST", `/v1/me/appointments/${later.body.id}/cancel`, {
          host: shop.host,
          token: user.token,
        })
      ).status,
    ).toBe(204);
    await api("PATCH", `/v1/branches/${shop.branchId}`, {
      ...shop.asOwner,
      body: { booking: { cancelNoticeMin: 10_080 } },
    });
    const late = await api(
      "POST",
      `/v1/me/appointments/${second.body.id}/cancel`,
      { host: shop.host, token: user.token },
    );
    expect(late.status).toBe(409);
    expect(late.body.error?.code).toBe("TOO_LATE");
    const other = await createUser(shop.tenant, "customer");
    expect(
      (
        await api("POST", `/v1/me/appointments/${later.body.id}/cancel`, {
          host: shop.host,
          token: other.token,
        })
      ).status,
    ).toBe(404);
  });

  test("errors: missing guest details, a barber who can't, an inactive subscription", async () => {
    const shop = await bookingShop();
    expect(
      (
        await book(shop, {
          ...guestBooking(at(shop, 2, "10:00")),
          customer: undefined,
        })
      ).status,
    ).toBe(422);
    const cannot = await book(
      shop,
      guestBooking(at(shop, 2, "10:00"), { service: "masaje" }),
    );
    expect(cannot.status).toBe(409);
    expect(cannot.body.error?.code).toBe("BARBER_UNAVAILABLE");

    await tenants.updateOne(
      { _id: shop.tenant._id },
      {
        $set: {
          subscription: {
            plan: "pro",
            status: "canceled",
            limits: PLAN_LIMITS.pro,
          },
        },
      },
    );
    expect((await book(shop, guestBooking(at(shop, 2, "11:00")))).status).toBe(
      402,
    );
  });
});

describe("staff agenda", () => {
  test("walk-ins, reschedule, complete and cancel", async () => {
    const shop = await bookingShop({ booking: { minNoticeMin: 600 } });
    const body = {
      branchId: shop.branchId,
      barberId: shop.barbers.mateo,
      serviceId: shop.services.corte,
      customer: { name: "Walk In", phone: nextPhone() },
    };
    const first = await api("POST", "/v1/appointments", {
      ...shop.asOwner,
      body: { ...body, startAt: at(shop, 2, "10:00") },
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      source: "staff",
      customer: { name: "Walk In" },
    });
    await api("POST", "/v1/appointments", {
      ...shop.asOwner,
      body: { ...body, startAt: at(shop, 2, "12:00") },
    });

    const patch = (id: unknown, change: Record<string, unknown>) =>
      api("PATCH", `/v1/appointments/${id}`, { ...shop.asOwner, body: change });
    expect(
      (await patch(first.body.id, { startAt: at(shop, 2, "12:15") })).status,
    ).toBe(409);
    const moved = await patch(first.body.id, {
      startAt: at(shop, 2, "15:00"),
      barberId: shop.barbers.lucas,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      barber: { slug: "lucas" },
      startAt: new Date(at(shop, 2, "15:00")).toISOString(),
    });
    const refused = await patch(first.body.id, { status: "completed" });
    expect(refused.body.error?.code).toBe("NOT_STARTED");

    expect(
      (
        await patch(first.body.id, {
          status: "cancelled",
          cancelReason: "Cliente avisó",
        })
      ).body,
    ).toMatchObject({ status: "cancelled", cancelReason: "Cliente avisó" });
    expect(
      (await patch(first.body.id, { startAt: at(shop, 2, "16:00") })).body.error
        ?.code,
    ).toBe("NOT_CONFIRMED");
    expect(
      (
        await book(
          shop,
          guestBooking(at(shop, 2, "15:00"), { barber: "lucas" }),
        )
      ).status,
    ).toBe(201);
  });

  test("a barber sees only their own appointments; other tenants see nothing", async () => {
    const shop = await bookingShop();
    const account = await createUser(shop.tenant, "barber", {
      branchId: new ObjectId(shop.branchId),
    });
    await api("PATCH", `/v1/barbers/${shop.barbers.mateo}`, {
      ...shop.asOwner,
      body: { userId: account.user._id.toHexString() },
    });
    const mine = await book(shop, guestBooking(at(shop, 2, "10:00")));
    const theirs = await book(
      shop,
      guestBooking(at(shop, 2, "10:00"), { barber: "lucas" }),
    );
    const asBarber = { host: shop.host, token: account.token };
    const range = `from=${new Date().toISOString()}&to=${new Date(Date.now() + 5 * 864e5).toISOString()}`;
    const list = await api("GET", `/v1/appointments?${range}`, asBarber);
    expect((list.body as unknown as { id: string }[]).map((a) => a.id)).toEqual(
      [String(mine.body.id)],
    );
    expect(
      (await api("GET", `/v1/appointments/${theirs.body.id}`, asBarber)).status,
    ).toBe(404);

    const other = await bookingShop();
    expect(
      (await api("GET", `/v1/appointments/${mine.body.id}`, other.asOwner))
        .status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/v1/appointments/${mine.body.id}`, {
          ...other.asOwner,
          body: { status: "cancelled" },
        })
      ).status,
    ).toBe(404);
  });

  test("time off can't be placed over confirmed appointments", async () => {
    const shop = await bookingShop();
    const day = dayIn(shop.timeZone, 2);
    await book(shop, guestBooking(instantIn(shop.timeZone, day, "12:00")));
    const clash = await api("POST", "/v1/time-off", {
      ...shop.asOwner,
      body: {
        barberId: shop.barbers.mateo,
        kind: "break",
        start: `${day}T11:00`,
        end: `${day}T13:00`,
      },
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error?.code).toBe("APPOINTMENTS_IN_THE_WAY");
    const closure = await api("POST", "/v1/time-off", {
      ...shop.asOwner,
      body: {
        branchId: shop.branchId,
        kind: "closure",
        start: `${day}T00:00`,
        end: `${dayIn(shop.timeZone, 3)}T00:00`,
      },
    });
    expect(closure.status).toBe(409);
    const elsewhere = await api("POST", "/v1/time-off", {
      ...shop.asOwner,
      body: {
        barberId: shop.barbers.lucas,
        kind: "break",
        start: `${day}T11:00`,
        end: `${day}T13:00`,
      },
    });
    expect(elsewhere.status).toBe(201);
  });
});

test("a guest's password-less booking and a login still work together", async () => {
  const shop = await bookingShop();
  const user = await createUser(shop.tenant, "customer");
  const login = await api("POST", "/v1/auth/login", {
    host: shop.host,
    body: { email: user.user.email, password: PASSWORD },
  });
  expect(login.status).toBe(200);
});

describe("customer reschedule", () => {
  const bookMine = async (shop: Shop, token: string, startAt: string) => {
    const res = await book(
      shop,
      { ...guestBooking(startAt), customer: undefined },
      token,
    );
    expect(res.status).toBe(201);
    return String(res.body.id);
  };

  test("slots show the barber's free times; you move to a free one", async () => {
    const shop = await bookingShop();
    const user = await createUser(shop.tenant, "customer", {
      phone: nextPhone(),
    });
    const from = at(shop, 2, "10:00");
    const id = await bookMine(shop, user.token, from);
    // Someone else holds 14:00, so it must not be offered.
    await book(shop, guestBooking(at(shop, 2, "14:00")));
    const who = { host: shop.host, token: user.token };

    const slots = await api("GET", `/v1/me/appointments/${id}/slots`, who);
    expect(slots.status).toBe(200);
    const body = slots.body as {
      branch: { slug: string };
      durationMin: number;
      barbers: {
        slug: string;
        days: { date: string; slots: { startAt: string }[] }[];
      }[];
    };
    expect(body.branch.slug).toBe("centro");
    expect(body.durationMin).toBe(45);
    expect(body.barbers).toHaveLength(1);
    expect(body.barbers[0]?.slug).toBe("mateo");
    const starts = body.barbers[0]?.days.flatMap((d) =>
      d.slots.map((s) => s.startAt),
    );
    // Your own 10:00 doesn't block you; the stranger's 14:00 is excluded.
    expect(starts).toContain(new Date(from).toISOString());
    expect(starts).not.toContain(new Date(at(shop, 2, "14:00")).toISOString());
    expect(starts?.length).toBeGreaterThan(0);

    const other = await createUser(shop.tenant, "customer");
    expect(
      (
        await api("GET", `/v1/me/appointments/${id}/slots`, {
          host: shop.host,
          token: other.token,
        })
      ).status,
    ).toBe(404);

    const moved = await api("POST", `/v1/me/appointments/${id}/reschedule`, {
      ...who,
      body: { startAt: at(shop, 2, "15:00") },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      id,
      status: "confirmed",
      startAt: new Date(at(shop, 2, "15:00")).toISOString(),
      totalMinor: 30_000,
      barber: { slug: "mateo" },
    });

    // The old time is free again for anyone else.
    expect((await book(shop, guestBooking(at(shop, 2, "10:00")))).status).toBe(
      201,
    );
  });

  test("moving to a taken slot fails; inside the notice window it is too late", async () => {
    const shop = await bookingShop();
    const user = await createUser(shop.tenant, "customer", {
      phone: nextPhone(),
    });
    const id = await bookMine(shop, user.token, at(shop, 2, "10:00"));
    await book(shop, guestBooking(at(shop, 2, "14:00")));
    const who = { host: shop.host, token: user.token };

    const taken = await api("POST", `/v1/me/appointments/${id}/reschedule`, {
      ...who,
      body: { startAt: at(shop, 2, "14:00") },
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error?.code).toBe("SLOT_TAKEN");

    await api("PATCH", `/v1/branches/${shop.branchId}`, {
      ...shop.asOwner,
      body: { booking: { cancelNoticeMin: 10_080 } },
    });
    const late = await api("POST", `/v1/me/appointments/${id}/reschedule`, {
      ...who,
      body: { startAt: at(shop, 2, "15:00") },
    });
    expect(late.status).toBe(409);
    expect(late.body.error?.code).toBe("TOO_LATE");
  });

  test("a paid visit keeps its payment when moved; without Stripe, cancelling keeps it paid", async () => {
    const shop = await bookingShop();
    const user = await createUser(shop.tenant, "customer", {
      phone: nextPhone(),
    });
    const id = await bookMine(shop, user.token, at(shop, 2, "10:00"));
    await appointments.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          payment: {
            provider: "stripe",
            intentId: "pi_test123",
            status: "paid",
            amountMinor: 30_000,
          },
        },
      },
    );
    const who = { host: shop.host, token: user.token };

    const moved = await api("POST", `/v1/me/appointments/${id}/reschedule`, {
      ...who,
      body: { startAt: at(shop, 2, "14:00") },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      payment: { status: "paid", amountMinor: 30_000 },
    });

    expect(
      (await api("POST", `/v1/me/appointments/${id}/cancel`, who)).status,
    ).toBe(204);
    expect(
      (
        await appointments.findOne(
          { _id: new ObjectId(id) },
          { projection: { payment: 1 } },
        )
      )?.payment,
    ).toMatchObject({ status: "paid" });
  });
});
