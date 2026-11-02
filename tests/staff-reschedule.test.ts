import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  addBranch,
  api,
  bookingShop,
  createUser,
  dayIn,
  instantIn,
  nextPhone,
  type Shop,
} from "./helpers";

type Slots = {
  durationMin: number;
  barbers: {
    id: string;
    slug: string;
    days: { date: string; slots: { startAt: string }[] }[];
  }[];
};

const at = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);

const walkIn = async (
  shop: Shop,
  startAt: string,
  extra: Record<string, unknown> = {},
) => {
  const res = await api("POST", "/v1/appointments", {
    ...shop.asOwner,
    body: {
      branchId: shop.branchId,
      barberId: shop.barbers.mateo,
      serviceId: shop.services.corte,
      customer: { name: "Walk In", phone: nextPhone() },
      startAt,
      ...extra,
    },
  });
  expect(res.status).toBe(201);
  return String(res.body.id);
};

const startsOf = (body: Slots, slug: string) =>
  body.barbers
    .find((b) => b.slug === slug)
    ?.days.flatMap((d) => d.slots.map((s) => s.startAt)) ?? [];

describe("staff reschedule slots", () => {
  test("the appointment's own time is free and only barbers who do its services are offered", async () => {
    const shop = await bookingShop();
    const from = at(shop, 2, "10:00");
    const id = await walkIn(shop, from, {
      barberId: shop.barbers.lucas,
      serviceId: shop.services.masaje,
    });
    await walkIn(shop, at(shop, 2, "14:00"), { barberId: shop.barbers.lucas });

    const res = await api("GET", `/v1/appointments/${id}/slots`, shop.asOwner);
    expect(res.status).toBe(200);
    const body = res.body as Slots;
    expect(body.durationMin).toBe(30);
    expect(body.barbers.map((b) => b.slug)).toEqual(["lucas"]);
    expect(body.barbers[0]?.id).toBe(shop.barbers.lucas);
    const starts = startsOf(body, "lucas");
    expect(starts).toContain(new Date(from).toISOString());
    expect(starts).not.toContain(new Date(at(shop, 2, "14:00")).toISOString());

    const moved = await api("PATCH", `/v1/appointments/${id}`, {
      ...shop.asOwner,
      body: { startAt: at(shop, 2, "15:00") },
    });
    expect(moved.status).toBe(200);
  });

  test("filters by barber and keeps a barber to themselves", async () => {
    const shop = await bookingShop();
    const id = await walkIn(shop, at(shop, 2, "11:00"));

    const lucasOnly = await api(
      "GET",
      `/v1/appointments/${id}/slots?barberId=${shop.barbers.lucas}`,
      shop.asOwner,
    );
    expect(lucasOnly.status).toBe(200);
    expect((lucasOnly.body as Slots).barbers.map((b) => b.slug)).toEqual([
      "lucas",
    ]);

    const account = await createUser(shop.tenant, "barber", {
      branchId: new ObjectId(shop.branchId),
    });
    const linked = await api("PATCH", `/v1/barbers/${shop.barbers.mateo}`, {
      ...shop.asOwner,
      body: { userId: account.user._id.toHexString() },
    });
    expect(linked.status).toBe(200);
    const asMateo = { host: shop.host, token: account.token };
    const own = await api(
      "GET",
      `/v1/appointments/${id}/slots?barberId=${shop.barbers.lucas}`,
      asMateo,
    );
    expect(own.status).toBe(200);
    expect((own.body as Slots).barbers.map((b) => b.slug)).toEqual(["mateo"]);
  });

  test("stays inside the agenda's scope and only moves confirmed appointments", async () => {
    const shop = await bookingShop();
    const id = await walkIn(shop, at(shop, 2, "12:00"));
    const elsewhere = await addBranch(shop.host, shop.owner.token, {
      slug: "norte",
      timeZone: shop.timeZone,
    });
    const manager = await createUser(shop.tenant, "manager", {
      branchId: new ObjectId(elsewhere),
    });
    expect(
      (
        await api("GET", `/v1/appointments/${id}/slots`, {
          host: shop.host,
          token: manager.token,
        })
      ).status,
    ).toBe(404);

    await api("PATCH", `/v1/appointments/${id}`, {
      ...shop.asOwner,
      body: { status: "cancelled" },
    });
    const cancelled = await api(
      "GET",
      `/v1/appointments/${id}/slots`,
      shop.asOwner,
    );
    expect(cancelled.status).toBe(409);
    expect(cancelled.body).toMatchObject({ error: { code: "NOT_CONFIRMED" } });
  });
});
