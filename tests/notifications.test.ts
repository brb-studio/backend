import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/app";
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

  test("customers can't open the stream", async () => {
    const shop = await bookingShop();
    const customer = await createUser(shop.tenant, "customer");
    expect(
      (
        await api("GET", "/v1/notifications", {
          host: shop.host,
          token: customer.token,
        })
      ).status,
    ).toBe(403);
    const res = await app.request("/v1/notifications/stream", {
      headers: {
        "X-Forwarded-Host": shop.host,
        Authorization: `Bearer ${customer.token}`,
      },
    });
    expect(res.status).toBe(403);
  });
});
