import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  createDecipheriv,
  createECDH,
  createHmac,
  type ECDH,
} from "node:crypto";
import { ObjectId } from "mongodb";
import { pushSubscriptions } from "../src/db/collections";
import { sendDigest } from "../src/features/notifications/digest";
import {
  api,
  bookingShop,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
  type Shop,
} from "./helpers";

const hmac = (key: Uint8Array, data: Uint8Array) =>
  createHmac("sha256", key).update(data).digest();

function fakeBrowser(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16)));
  const subscription = {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
  return { subscription, decrypt: (body: Buffer) => decrypt(body, ecdh, auth) };
}

function decrypt(body: Buffer, browser: ECDH, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const prkKey = hmac(auth, browser.computeSecret(serverKey));
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    browser.getPublicKey(),
    serverKey,
  ]);
  const prk = hmac(salt, hmac(prkKey, Buffer.concat([info, Buffer.from([1])])));
  const cek = hmac(
    prk,
    Buffer.from("Content-Encoding: aes128gcm\0\x01"),
  ).subarray(0, 16);
  const nonce = hmac(
    prk,
    Buffer.from("Content-Encoding: nonce\0\x01"),
  ).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([
    decipher.update(sealed.subarray(0, -16)),
    decipher.final(),
  ]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString());
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

type FetchCall = [input: string | URL | Request, init?: RequestInit];
const pushCalls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls as FetchCall[];

async function until(check: () => boolean | Promise<boolean>, ms = 3_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

const pushService = (status: number) =>
  Object.assign(async () => new Response(null, { status }), {
    preconnect: fetch.preconnect,
  });

let restore: (() => void) | undefined;
afterEach(() => restore?.());

describe("web push", () => {
  test("a booking reaches the barber's phone, encrypted, signed and readable only by that device", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const phone = fakeBrowser("https://fcm.googleapis.com/fcm/send/device-1");
    expect(
      (
        await api("POST", "/v1/notifications/push-subscriptions", {
          ...barber,
          body: phone.subscription,
        })
      ).status,
    ).toBe(204);

    const spy = spyOn(globalThis, "fetch").mockImplementation(pushService(201));
    restore = () => spy.mockRestore();
    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00"), {
        customer: { name: "Ana López", phone: "+526641239876" },
      }),
    });
    await until(() => spy.mock.calls.length > 0);

    const [input, init] = pushCalls(spy)[0] ?? [""];
    expect(String(input)).toBe(phone.subscription.endpoint);
    const headers = new Headers(init?.headers);
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("authorization")).toStartWith("vapid t=");
    expect(headers.get("urgency")).toBe("high");
    const message = phone.decrypt(Buffer.from(init?.body as Uint8Array));
    expect(message).toMatchObject({
      title: `Nueva cita · ${shop.tenant.name}`,
      url: "/es/account",
    });
    expect(message.body).toContain("Ana López");
    expect(message.body).toContain("corte");
  });

  test("a device the push service says is gone (410) is forgotten", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const phone = fakeBrowser("https://web.push.apple.com/device-gone");
    await api("POST", "/v1/notifications/push-subscriptions", {
      ...barber,
      body: phone.subscription,
    });

    const spy = spyOn(globalThis, "fetch").mockImplementation(pushService(410));
    restore = () => spy.mockRestore();
    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "12:00")),
    });
    await until(() => spy.mock.calls.length > 0);
    await until(
      async () =>
        (await pushSubscriptions.countDocuments({
          endpoint: phone.subscription.endpoint,
        })) === 0,
    );
  });

  test("only push service endpoints and well-formed keys; signed-in accounts only", async () => {
    const shop = await bookingShop();
    const barber = await barberAccount(shop);
    const good = fakeBrowser(
      "https://fcm.googleapis.com/fcm/send/ok",
    ).subscription;
    for (const body of [
      { ...good, endpoint: "http://127.0.0.1:27017/" },
      { ...good, endpoint: "https://evil.example.com/push" },
      { ...good, keys: { ...good.keys, p256dh: "AAAA" } },
      { ...good, keys: { ...good.keys, auth: "short" } },
    ]) {
      expect(
        (
          await api("POST", "/v1/notifications/push-subscriptions", {
            ...barber,
            body,
          })
        ).status,
      ).toBe(422);
    }
    expect(
      (
        await api("POST", "/v1/notifications/push-subscriptions", {
          host: shop.host,
          body: good,
        })
      ).status,
    ).toBe(401);
    const customer = await createUser(shop.tenant, "customer");
    expect(
      (
        await api("POST", "/v1/notifications/push-subscriptions", {
          host: shop.host,
          token: customer.token,
          body: good,
        })
      ).status,
    ).toBe(204);
    const key = await api("GET", "/v1/notifications/push-key", barber);
    expect(key.body.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
  });

  test("a device moves to whoever subscribed it last, and unsubscribing removes it", async () => {
    const shop = await bookingShop();
    const first = await barberAccount(shop);
    const second = await createUser(shop.tenant, "manager", {
      branchId: new ObjectId(shop.branchId),
    });
    const device = fakeBrowser(
      "https://fcm.googleapis.com/fcm/send/shared",
    ).subscription;
    await api("POST", "/v1/notifications/push-subscriptions", {
      ...first,
      body: device,
    });
    await api("POST", "/v1/notifications/push-subscriptions", {
      host: shop.host,
      token: second.token,
      body: device,
    });
    const stored = await pushSubscriptions
      .find({ endpoint: device.endpoint })
      .toArray();
    expect(stored.map((s) => s.userId.toHexString())).toEqual([
      second.user._id.toHexString(),
    ]);
    await api("DELETE", "/v1/notifications/push-subscriptions", {
      host: shop.host,
      token: second.token,
      body: { endpoint: device.endpoint },
    });
    expect(
      await pushSubscriptions.countDocuments({ endpoint: device.endpoint }),
    ).toBe(0);
  });

  test("a customer's phone hears what the shop does to their visit, titled with the shop's name", async () => {
    const shop = await bookingShop();
    const customer = await createUser(shop.tenant, "customer");
    const who = { host: shop.host, token: customer.token };
    const phone = fakeBrowser("https://web.push.apple.com/customer-1");
    await api("POST", "/v1/notifications/push-subscriptions", {
      ...who,
      body: phone.subscription,
    });
    const spy = spyOn(globalThis, "fetch").mockImplementation(pushService(201));
    restore = () => spy.mockRestore();
    const sent = () =>
      pushCalls(spy).map(([, init]) =>
        phone.decrypt(Buffer.from(init?.body as Uint8Array)),
      );

    // Their own booking is no news to them.
    const own = await api("POST", "/v1/public/appointments", {
      ...who,
      body: guestBooking(at(shop, 2, "11:00"), { customer: undefined }),
    });
    await Bun.sleep(100);
    expect(spy.mock.calls).toHaveLength(0);

    await api("PATCH", `/v1/appointments/${own.body.id}`, {
      ...shop.asOwner,
      body: { startAt: at(shop, 2, "15:00") },
    });
    await until(() => spy.mock.calls.length === 1);
    expect(sent()[0]).toMatchObject({
      title: `Tu cita fue reprogramada · ${shop.tenant.name}`,
      url: "/es/account",
    });

    await api("PATCH", `/v1/appointments/${own.body.id}`, {
      ...shop.asOwner,
      body: { status: "cancelled" },
    });
    await until(() => spy.mock.calls.length === 2);
    expect(sent()[1]).toMatchObject({
      title: `Tu cita fue cancelada · ${shop.tenant.name}`,
    });

    // A guest has no account and no device: booking and cancelling for them pushes nothing.
    const guest = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 3, "11:00")),
    });
    await api("PATCH", `/v1/appointments/${guest.body.id}`, {
      ...shop.asOwner,
      body: { status: "cancelled" },
    });
    await Bun.sleep(100);
    expect(spy.mock.calls).toHaveLength(2);
  });

  test("owners get one morning summary per branch and day, only when there is something to say", async () => {
    const shop = await bookingShop();
    const phone = fakeBrowser("https://web.push.apple.com/owner-digest");
    await api("POST", "/v1/notifications/push-subscriptions", {
      ...shop.asOwner,
      body: phone.subscription,
    });
    const spy = spyOn(globalThis, "fetch").mockImplementation(pushService(201));
    restore = () => spy.mockRestore();
    const day = dayIn(shop.timeZone, 2);
    const run = (time: string) =>
      sendDigest(shop.tenant, new Date(instantIn(shop.timeZone, day, time)));

    // A quiet day sends nothing (and uses up only that day's slot).
    await sendDigest(
      shop.tenant,
      new Date(instantIn(shop.timeZone, dayIn(shop.timeZone, 3), "09:00")),
    );
    expect(spy.mock.calls).toHaveLength(0);

    await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00")),
    });
    const afterBooking = spy.mock.calls.length;
    await run("07:00"); // too early for the branch's clock
    expect(spy.mock.calls).toHaveLength(afterBooking);

    await run("09:00");
    expect(spy.mock.calls).toHaveLength(afterBooking + 1);
    const [, init] = pushCalls(spy).at(-1) ?? ["", undefined];
    expect(phone.decrypt(Buffer.from(init?.body as Uint8Array))).toMatchObject({
      title: `Resumen del día · ${shop.tenant.name}`,
      body: "Centro · 1 cita hoy",
      url: "/es/admin",
    });

    await run("09:30"); // already sent today
    expect(spy.mock.calls).toHaveLength(afterBooking + 1);
  });

  test("the cron endpoint does not exist without its secret", async () => {
    expect(
      (await api("GET", "/cron/digest", { host: "x.localhost" })).status,
    ).toBe(404);
  });
});
