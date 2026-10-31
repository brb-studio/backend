import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ObjectId } from "mongodb";
import { nativePushDevices, pushReceipts } from "../src/db/collections";
import { checkNativeReceipts } from "../src/features/notifications/native-push";
import {
  api,
  bookingShop,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
  type Shop,
} from "./helpers";

const tokenFor = (id: string) => `ExponentPushToken[${id.padEnd(22, "x")}]`;

type Fake = {
  ticket: (to: string) => unknown;
  receipt?: (ticketId: string) => unknown;
};

function expoService(fake: Fake) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body: unknown = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url, body });
    if (url.endsWith("/send")) {
      const messages = body as { to: string }[];
      return Response.json({ data: messages.map((m) => fake.ticket(m.to)) });
    }
    if (url.endsWith("/getReceipts")) {
      const { ids } = body as { ids: string[] };
      return Response.json({
        data: Object.fromEntries(
          ids.map((id) => [id, fake.receipt?.(id) ?? { status: "ok" }]),
        ),
      });
    }
    return new Response(null, { status: 404 });
  };
  return { impl: Object.assign(impl, { preconnect: fetch.preconnect }), calls };
}

async function barberAccount(shop: Shop) {
  const account = await createUser(shop.tenant, "barber", {
    branchId: new ObjectId(shop.branchId),
  });
  await api("PATCH", `/v1/barbers/${shop.barbers.mateo}`, {
    ...shop.asOwner,
    body: { userId: account.user._id.toHexString() },
  });
  return { host: shop.host, token: account.token, userId: account.user._id };
}

const at = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);

async function until(check: () => boolean | Promise<boolean>, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("native push devices", () => {
  test("a signed-in account registers its phone; anonymous and malformed requests are refused", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const body = { token: tokenFor("registers"), platform: "ios" };

    expect(
      (
        await api("POST", "/v1/notifications/native-devices", {
          host: shop.host,
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await api("POST", "/v1/notifications/native-devices", {
          ...barber,
          body: {
            token: "https://fcm.googleapis.com/fcm/send/x",
            platform: "ios",
          },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api("POST", "/v1/notifications/native-devices", {
          ...barber,
          body,
        })
      ).status,
    ).toBe(204);

    const stored = await nativePushDevices.findOne({ token: body.token });
    expect(stored?.userId.equals(barber.userId)).toBe(true);
    expect(stored?.platform).toBe("ios");
  });

  test("a booking reaches the barber's phone with the time and route, never the customer's name", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const token = tokenFor("minimal");
    await api("POST", "/v1/notifications/native-devices", {
      ...barber,
      body: { token, platform: "android" },
    });

    const expo = expoService({
      ticket: () => ({ status: "ok", id: "ticket-minimal" }),
    });
    const spy = spyOn(globalThis, "fetch").mockImplementation(expo.impl);
    restore = () => spy.mockRestore();

    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00"), {
        customer: { name: "Ana López", phone: "+526641239876" },
      }),
    });
    await until(() => expo.calls.some((c) => c.url.endsWith("/send")));

    const send = expo.calls.find((c) => c.url.endsWith("/send"));
    const messages = send?.body as Array<Record<string, unknown>> | undefined;
    const message = messages?.[0];
    expect(message?.to).toBe(token);
    expect(message?.data).toEqual({
      url: "/es/account",
      tag: expect.any(String),
    });
    expect(JSON.stringify(send?.body)).not.toContain("Ana López");
    expect(JSON.stringify(send?.body)).not.toContain("Corte");
    expect(String(message?.title)).toContain("Barbería de prueba");
  });

  test("a device Expo reports as gone is removed at once", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const token = tokenFor("gone-now");
    await api("POST", "/v1/notifications/native-devices", {
      ...barber,
      body: { token, platform: "ios" },
    });

    const expo = expoService({
      ticket: () => ({
        status: "error",
        message: "not registered",
        details: { error: "DeviceNotRegistered" },
      }),
    });
    const spy = spyOn(globalThis, "fetch").mockImplementation(expo.impl);
    restore = () => spy.mockRestore();

    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 3, "12:00"), {
        customer: { name: "Luis Ortega", phone: "+526641230001" },
      }),
    });
    await until(
      async () => (await nativePushDevices.countDocuments({ token })) === 0,
    );
  });

  test("an accepted ticket is checked later and a gone device is removed then", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const token = tokenFor("receipt-gone");
    await api("POST", "/v1/notifications/native-devices", {
      ...barber,
      body: { token, platform: "ios" },
    });

    const expo = expoService({
      ticket: () => ({ status: "ok", id: "ticket-receipt" }),
      receipt: () => ({
        status: "error",
        message: "gone",
        details: { error: "DeviceNotRegistered" },
      }),
    });
    const spy = spyOn(globalThis, "fetch").mockImplementation(expo.impl);
    restore = () => spy.mockRestore();

    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 4, "13:00"), {
        customer: { name: "Marta Vega", phone: "+526641230002" },
      }),
    });
    await until(
      async () =>
        (await pushReceipts.countDocuments({ ticketId: "ticket-receipt" })) ===
        1,
    );
    expect(await nativePushDevices.countDocuments({ token })).toBe(1);

    await checkNativeReceipts(new Date(Date.now() + 60 * 60 * 1000));

    expect(await nativePushDevices.countDocuments({ token })).toBe(0);
    expect(
      await pushReceipts.countDocuments({ ticketId: "ticket-receipt" }),
    ).toBe(0);
  });

  test("an account keeps at most ten phones and loses the one it used longest ago", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const tokens = Array.from({ length: 11 }, (_, i) => tokenFor(`phone-${i}`));
    for (const token of tokens) {
      expect(
        (
          await api("POST", "/v1/notifications/native-devices", {
            ...barber,
            body: { token, platform: "ios" },
          })
        ).status,
      ).toBe(204);
      await Bun.sleep(2);
    }

    const kept = await nativePushDevices
      .find({ userId: barber.userId })
      .toArray();
    expect(kept).toHaveLength(10);
    expect(kept.map((d) => d.token)).not.toContain(tokens[0]);
    expect(kept.map((d) => d.token)).toContain(tokens.at(-1) ?? "");
  });

  test("removing a token only works for the account that owns it", async () => {
    const shop = await bookingShop();
    const owner = await barberAccount(shop);
    const stranger = await createUser(shop.tenant, "customer");
    const token = tokenFor("owned");
    await api("POST", "/v1/notifications/native-devices", {
      ...owner,
      body: { token, platform: "ios" },
    });

    await api("DELETE", "/v1/notifications/native-devices", {
      host: shop.host,
      token: stranger.token,
      body: { token },
    });
    expect(await nativePushDevices.countDocuments({ token })).toBe(1);

    await api("DELETE", "/v1/notifications/native-devices", {
      ...owner,
      body: { token },
    });
    expect(await nativePushDevices.countDocuments({ token })).toBe(0);
  });
});
