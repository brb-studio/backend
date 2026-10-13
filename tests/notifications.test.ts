import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/app";
import { users } from "../src/db/collections";
import { myDay } from "../src/features/booking/my-day";
import { outbox } from "../src/shared/mail";
import {
  api,
  bookingShop,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
  type Shop,
} from "./helpers";

type Feed = {
  unread: number;
  total: number;
  page: number;
  pageSize: number;
  items: {
    type: string;
    appointmentId: string;
    summary: { customerName: string; start: string };
  }[];
};

async function linkedBarber(shop: Shop, barberId: string) {
  const account = await createUser(shop.tenant, "barber", {
    branchId: new ObjectId(shop.branchId),
  });
  await api("PATCH", `/v1/barbers/${barberId}`, {
    ...shop.asOwner,
    body: { userId: account.user._id.toHexString() },
  });
  return { host: shop.host, token: account.token };
}
const feed = async (who: { host: string; token: string }) =>
  (await api("GET", "/v1/notifications", who)).body as unknown as Feed;
const at = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);

describe("barber notifications", () => {
  test("a booking notifies its barber only; read marks clear the badge", async () => {
    const shop = await bookingShop();
    const mateo = await linkedBarber(shop, shop.barbers.mateo);
    const lucas = await linkedBarber(shop, shop.barbers.lucas);
    const booked = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00"), {
        customer: { name: "Ana López", phone: "+526640000001" },
      }),
    });

    const mine = await feed(mateo);
    expect(mine.unread).toBe(1);
    expect(mine.items[0]).toMatchObject({
      type: "appointment.booked",
      appointmentId: booked.body.id,
      summary: {
        customerName: "Ana López",
        start: `${dayIn(shop.timeZone, 2)}T11:00`,
      },
    });
    expect((await feed(lucas)).items).toEqual([]);

    expect(
      (await api("POST", "/v1/notifications/read", { ...mateo, body: {} }))
        .status,
    ).toBe(204);
    expect((await feed(mateo)).unread).toBe(0);
    expect((await feed(shop.asOwner)).items).toEqual([]);
  });

  test("every notice also goes out by email to its recipient", async () => {
    const shop = await bookingShop();
    const barberAccount = await createUser(shop.tenant, "barber", {
      branchId: new ObjectId(shop.branchId),
    });
    await api("PATCH", `/v1/barbers/${shop.barbers.mateo}`, {
      ...shop.asOwner,
      body: { userId: barberAccount.user._id.toHexString() },
    });
    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00"), {
        customer: { name: "Ana López", phone: "+526640000002" },
      }),
    });
    const to = barberAccount.user.email as string;
    for (let i = 0; i < 100 && !outbox.some((m) => m.to === to); i++) {
      await Bun.sleep(20);
    }
    const mail = outbox.find((m) => m.to === to);
    expect(mail?.subject).toContain("Nueva cita");
    expect(mail?.text).toContain("Ana López");
  });

  test("the feed pages by page and pageSize and reports the total", async () => {
    const shop = await bookingShop();
    const mateo = await linkedBarber(shop, shop.barbers.mateo);
    for (const time of ["10:00", "11:00", "12:00"]) {
      await api("POST", "/v1/public/appointments", {
        host: shop.host,
        body: guestBooking(at(shop, 2, time)),
      });
    }
    const list = async (qs: string) =>
      (await api("GET", `/v1/notifications${qs}`, mateo))
        .body as unknown as Feed;
    const first = await list("?page=1&pageSize=2");
    const second = await list("?page=2&pageSize=2");
    expect([first.items.length, first.total, first.pageSize]).toEqual([
      2, 3, 2,
    ]);
    expect([second.items.length, second.page]).toEqual([1, 2]);
    expect(
      new Set([...first.items, ...second.items].map((n) => n.appointmentId))
        .size,
    ).toBe(3);
    expect(
      (await api("GET", "/v1/notifications?pageSize=500", mateo)).status,
    ).toBe(422);
  });

  test("an owner who is also a barber hears about their own appointments and keeps owner powers", async () => {
    const shop = await bookingShop();
    const linked = await api("PATCH", `/v1/barbers/${shop.barbers.mateo}`, {
      ...shop.asOwner,
      body: { userId: shop.owner.user._id.toHexString() },
    });
    expect(linked.status).toBe(200);
    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00")),
    });
    expect((await feed(shop.asOwner)).items.map((n) => n.type)).toEqual([
      "appointment.booked",
    ]);
    expect((await api("GET", "/v1/users", shop.asOwner)).status).toBe(200);
  });

  test("my day lists only my cuts for today, on the branch's clock", async () => {
    const shop = await bookingShop();
    const mateo = await linkedBarber(shop, shop.barbers.mateo);
    const none = await api("GET", "/v1/appointments/my-day", shop.asOwner);
    expect(none.body).toEqual({ barber: null });

    // Today in the branch's own calendar: book through the staff API at a time still ahead of now.
    await api("PATCH", `/v1/barbers/${shop.barbers.lucas}`, {
      ...shop.asOwner,
      body: { userId: shop.owner.user._id.toHexString() },
    });
    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00")),
    });
    const mine = (await api("GET", "/v1/appointments/my-day", mateo))
      .body as unknown as {
      barber: { name: string } | null;
      date: string;
      appointments: unknown[];
    };
    expect(mine.barber?.name).toBeString();
    expect(mine.date).toBe(dayIn(shop.timeZone, 0));
    expect(mine.appointments).toEqual([]); // the booking is two days away
    // On the booking's own day it shows up, with the barber's clock deciding what "today" is.
    const bookingDay = new Date(
      instantIn(shop.timeZone, dayIn(shop.timeZone, 2), "09:00"),
    );
    const barberAccount = await users.findOne({
      role: "barber",
      tenantId: shop.tenant._id,
    });
    const onTheDay = await myDay(
      {
        userId: barberAccount?._id ?? new ObjectId(),
        tenantId: shop.tenant._id,
        role: "barber",
      },
      bookingDay,
    );
    expect(onTheDay.appointments).toHaveLength(1);
    const owner = (await api("GET", "/v1/appointments/my-day", shop.asOwner))
      .body as unknown as { barber: { id: string } | null };
    expect(owner.barber?.id).toBe(shop.barbers.lucas);
  });

  test("moving an appointment tells both barbers; a barber's own change tells nobody", async () => {
    const shop = await bookingShop();
    const mateo = await linkedBarber(shop, shop.barbers.mateo);
    const lucas = await linkedBarber(shop, shop.barbers.lucas);
    const booked = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00")),
    });
    await api("PATCH", `/v1/appointments/${booked.body.id}`, {
      ...shop.asOwner,
      body: { barberId: shop.barbers.lucas, startAt: at(shop, 2, "15:00") },
    });
    expect((await feed(lucas)).items.map((n) => n.type)).toEqual([
      "appointment.rescheduled",
    ]);
    expect((await feed(mateo)).items.map((n) => n.type)).toEqual([
      "appointment.cancelled",
      "appointment.booked",
    ]);

    await api("PATCH", `/v1/appointments/${booked.body.id}`, {
      ...lucas,
      body: { status: "cancelled" },
    });
    expect((await feed(lucas)).items).toHaveLength(1);
  });

  test("arrives live over Server-Sent Events", async () => {
    const shop = await bookingShop();
    const mateo = await linkedBarber(shop, shop.barbers.mateo);
    const res = await app.request("/v1/notifications/stream", {
      headers: {
        "X-Forwarded-Host": mateo.host,
        Authorization: `Bearer ${mateo.token}`,
      },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    if (!res.body) throw new Error("no stream body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const waitFor = async (needle: string) => {
      const deadline = Date.now() + 5_000;
      while (!received.includes(needle)) {
        if (Date.now() > deadline)
          throw new Error(`no "${needle}" in: ${received}`);
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(5_000).then(() => ({ done: true, value: undefined })),
        ]);
        if (chunk.done) throw new Error(`stream ended before "${needle}"`);
        received += decoder.decode(chunk.value);
      }
    };

    await waitFor("event: ready");
    const booked = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "12:00")),
    });
    await waitFor("event: notification");
    expect(received).toContain(String(booked.body.id));
    await reader.cancel();
  });

  test("the inbox and stream need a signed-in account, and a customer sees only their own", async () => {
    const shop = await bookingShop();
    const customer = await createUser(shop.tenant, "customer");
    expect(
      (await api("GET", "/v1/notifications", { host: shop.host })).status,
    ).toBe(401);
    expect(
      (
        await api("GET", "/v1/notifications", {
          host: shop.host,
          token: customer.token,
        })
      ).body,
    ).toMatchObject({ unread: 0, items: [] });
  });
});
