import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { appointments, payments } from "../src/db/collections";
import {
  api,
  bookingShop,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
  type Shop,
} from "./helpers";

// Published example CLABEs, not real accounts.
const CLABE = "002010077777777771";
const OTHER_CLABE = "032180000118359719";
const HOLDER = "Barbería Centro SA de CV";

const settings = (shop: Shop, body: Record<string, unknown>) =>
  api("PATCH", "/v1/payments/settings", { ...shop.asOwner, body });

async function transferShop(clabe = CLABE) {
  const shop = await bookingShop();
  const res = await settings(shop, {
    bankTransferEnabled: true,
    bankAccountKey: clabe,
    bankAccountHolder: HOLDER,
  });
  expect(res.status).toBe(200);
  return shop;
}

async function bookAsGuest(shop: Shop, days: number) {
  const startAt = instantIn(shop.timeZone, dayIn(shop.timeZone, days), "11:00");
  const res = await api("POST", "/v1/public/appointments", {
    host: shop.host,
    body: guestBooking(startAt),
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; paymentToken: string };
}

const askTransfer = (shop: Shop, body: Record<string, unknown>) =>
  api("POST", "/v1/public/payments/transfer", { host: shop.host, body });

async function pending(shop: Shop, days = 2) {
  const booking = await bookAsGuest(shop, days);
  const res = await askTransfer(shop, {
    appointmentId: booking.id,
    paymentToken: booking.paymentToken,
  });
  expect(res.status).toBe(201);
  return { booking, id: String(res.body.id), body: res.body };
}

const confirm = (shop: Shop, id: string, body: Record<string, unknown>) =>
  api("POST", `/v1/payments/${id}/confirm`, { ...shop.asOwner, body });

const summary = async (appointmentId: string) =>
  (await appointments.findOne({ _id: new ObjectId(appointmentId) }))?.payment;

describe("bank settings", () => {
  test("owner saves a valid CLABE; invalid ones and half-set transfers are refused", async () => {
    const shop = await bookingShop();
    const bad = (body: Record<string, unknown>) => settings(shop, body);
    expect(
      (
        await bad({
          bankTransferEnabled: true,
          bankAccountKey: "002010077777777772",
          bankAccountHolder: HOLDER,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await bad({
          bankTransferEnabled: true,
          bankAccountKey: "123",
          bankAccountHolder: HOLDER,
        })
      ).status,
    ).toBe(422);
    expect((await bad({ bankTransferEnabled: true })).status).toBe(422);
    expect(
      (
        await bad({
          bankTransferEnabled: true,
          bankAccountKey: CLABE,
          bankAccountHolder: HOLDER,
          tenantId: new ObjectId().toHexString(),
        })
      ).status,
    ).toBe(422);

    // Not accepting transfers needs no account at all.
    expect((await bad({ bankTransferEnabled: false })).status).toBe(200);
    const saved = await bad({
      bankTransferEnabled: true,
      bankAccountKey: CLABE,
      bankAccountHolder: HOLDER,
    });
    expect(saved.body).toMatchObject({
      bankTransferEnabled: true,
      bankAccountKey: CLABE,
    });
  });

  test("only owner and admin read or change them; the public tenant never shows the account", async () => {
    const shop = await transferShop();
    const manager = await createUser(shop.tenant, "manager");
    const barber = await createUser(shop.tenant, "barber");
    for (const who of [manager, barber]) {
      const auth = { host: shop.host, token: who.token };
      expect((await api("GET", "/v1/payments/settings", auth)).status).toBe(
        403,
      );
      expect(
        (
          await api("PATCH", "/v1/payments/settings", {
            ...auth,
            body: { bankTransferEnabled: false },
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await api("GET", "/v1/payments/settings", shop.asOwner)).status,
    ).toBe(200);

    const publicTenant = await api("GET", "/v1/public/tenant", {
      host: shop.host,
    });
    expect(publicTenant.body).toMatchObject({ payments: { transfer: true } });
    expect(JSON.stringify(publicTenant.body)).not.toContain(CLABE);
    const staffTenant = await api("GET", "/v1/tenant", shop.asOwner);
    expect(JSON.stringify(staffTenant.body)).not.toContain(CLABE);
  });
});

describe("asking to pay by transfer", () => {
  test("a tenant without a CLABE (or with transfers off) offers nothing", async () => {
    const shop = await bookingShop();
    const booking = await bookAsGuest(shop, 2);
    const body = {
      appointmentId: booking.id,
      paymentToken: booking.paymentToken,
    };
    const res = await askTransfer(shop, body);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("TRANSFER_NOT_AVAILABLE");

    await settings(shop, {
      bankTransferEnabled: false,
      bankAccountKey: CLABE,
      bankAccountHolder: HOLDER,
    });
    expect((await askTransfer(shop, body)).status).toBe(409);
    expect(
      (await api("GET", "/v1/public/tenant", { host: shop.host })).body,
    ).toMatchObject({ payments: { transfer: false } });
  });

  test("needs the booking token; amount and account come from the database", async () => {
    const shop = await transferShop();
    const mine = await bookAsGuest(shop, 2);
    const theirs = await bookAsGuest(shop, 3);
    expect(mine.paymentToken).toMatch(/^[\w-]{43}$/);

    expect((await askTransfer(shop, { appointmentId: theirs.id })).status).toBe(
      404,
    );
    expect(
      (
        await askTransfer(shop, {
          appointmentId: theirs.id,
          paymentToken: mine.paymentToken,
        })
      ).status,
    ).toBe(404);
    // A client-sent amount or tenant is not even accepted.
    expect(
      (
        await askTransfer(shop, {
          appointmentId: mine.id,
          paymentToken: mine.paymentToken,
          amountMinor: 1,
        })
      ).status,
    ).toBe(422);

    const ok = await askTransfer(shop, {
      appointmentId: mine.id,
      paymentToken: mine.paymentToken,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      appointmentId: mine.id,
      status: "pending",
      amountMinor: 30_000,
      currency: "MXN",
      clabe: CLABE,
      holder: HOLDER,
    });
    expect(await summary(mine.id)).toMatchObject({
      provider: "spei",
      status: "pending",
      amountMinor: 30_000,
    });

    // Asking again returns the same pending transfer, not a second one.
    const again = await askTransfer(shop, {
      appointmentId: mine.id,
      paymentToken: mine.paymentToken,
    });
    expect(again.body.id).toBe(ok.body.id);
    expect(
      await payments.countDocuments({ appointmentId: new ObjectId(mine.id) }),
    ).toBe(1);
  });

  test("owners and admins are told once, when the transfer is first requested", async () => {
    const shop = await transferShop();
    const booking = await bookAsGuest(shop, 2);
    const body = {
      appointmentId: booking.id,
      paymentToken: booking.paymentToken,
    };
    const feed = async () =>
      (await api("GET", "/v1/notifications", shop.asOwner)).body as unknown as {
        items: { type: string }[];
      };
    expect((await feed()).items).toEqual([]);
    expect((await askTransfer(shop, body)).status).toBe(201);
    expect((await askTransfer(shop, body)).status).toBe(201);
    expect((await feed()).items.map((n) => n.type)).toEqual([
      "payment.transfer_requested",
    ]);
  });

  test("a signed-in customer pays only their own appointment", async () => {
    const shop = await transferShop();
    const booking = await bookAsGuest(shop, 2);
    const stranger = await createUser(shop.tenant, "customer");
    const res = await api("POST", "/v1/public/payments/transfer", {
      host: shop.host,
      token: stranger.token,
      body: { appointmentId: booking.id },
    });
    expect(res.status).toBe(404);
    const staff = await api("POST", "/v1/public/payments/transfer", {
      ...shop.asOwner,
      body: { appointmentId: booking.id },
    });
    expect(staff.status).toBe(403);
  });

  test("changing the bank account does not alter a transfer already requested", async () => {
    const shop = await transferShop();
    const { body, booking } = await pending(shop);
    await settings(shop, {
      bankTransferEnabled: true,
      bankAccountKey: OTHER_CLABE,
      bankAccountHolder: "Otro titular",
    });
    const again = await askTransfer(shop, {
      appointmentId: booking.id,
      paymentToken: booking.paymentToken,
    });
    expect(again.body).toMatchObject({ id: body.id, clabe: CLABE });
    const fresh = await bookAsGuest(shop, 3);
    const next = await askTransfer(shop, {
      appointmentId: fresh.id,
      paymentToken: fresh.paymentToken,
    });
    expect(next.body).toMatchObject({ clabe: OTHER_CLABE });
  });
});

describe("confirming and rejecting", () => {
  test("confirming marks the payment and the appointment paid, with who and when", async () => {
    const shop = await transferShop();
    const { id, booking } = await pending(shop);

    const listed = await api("GET", "/v1/payments", shop.asOwner);
    expect(listed.status).toBe(200);
    expect<unknown>(listed.body).toEqual([
      expect.objectContaining({ id, customerName: "Ana López" }),
    ]);

    const wrong = await confirm(shop, id, { receivedMinor: 29_999 });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error?.code).toBe("AMOUNT_MISMATCH");
    expect((await summary(booking.id))?.status).toBe("pending");

    const ok = await confirm(shop, id, {
      receivedMinor: 30_000,
      reference: "MBAN01ABC",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "paid", reference: "MBAN01ABC" });
    expect(await summary(booking.id)).toMatchObject({
      provider: "spei",
      status: "paid",
    });
    const doc = await payments.findOne({ _id: new ObjectId(id) });
    expect(doc?.resolvedBy?.equals(shop.owner.user._id)).toBe(true);
    expect(doc?.history.map((h) => h.status)).toEqual(["pending", "paid"]);

    // Paying again is refused; nothing else is written.
    const dup = await confirm(shop, id, { receivedMinor: 30_000 });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe("INVALID_TRANSITION");
    expect(
      (await payments.findOne({ _id: new ObjectId(id) }))?.history,
    ).toHaveLength(2);
    expect(
      (
        await askTransfer(shop, {
          appointmentId: booking.id,
          paymentToken: booking.paymentToken,
        })
      ).body.error?.code,
    ).toBe("ALREADY_PAID");
    expect(
      (
        await api("POST", `/v1/payments/${id}/reject`, {
          ...shop.asOwner,
          body: {},
        })
      ).status,
    ).toBe(409);
  });

  test("rejecting keeps the reason and lets the customer try again", async () => {
    const shop = await transferShop();
    const { id, booking } = await pending(shop);
    const res = await api("POST", `/v1/payments/${id}/reject`, {
      ...shop.asOwner,
      body: { reason: "No llegó el dinero" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "rejected",
      rejectionReason: "No llegó el dinero",
    });
    expect((await summary(booking.id))?.status).toBe("rejected");
    expect((await confirm(shop, id, { receivedMinor: 30_000 })).status).toBe(
      409,
    );

    const retry = await askTransfer(shop, {
      appointmentId: booking.id,
      paymentToken: booking.paymentToken,
    });
    expect(retry.status).toBe(201);
    expect(retry.body.id).not.toBe(id);
    const history = await api(
      "GET",
      "/v1/payments?status=rejected",
      shop.asOwner,
    );
    expect<unknown>(history.body).toEqual([
      expect.objectContaining({
        id,
        history: [
          expect.objectContaining({ status: "pending" }),
          expect.objectContaining({ status: "rejected" }),
        ],
      }),
    ]);
  });

  test("only owner and admin resolve payments; customers cannot confirm their own", async () => {
    const shop = await transferShop();
    const { id } = await pending(shop);
    const customer = await createUser(shop.tenant, "customer");
    const manager = await createUser(shop.tenant, "manager");
    for (const who of [customer, manager]) {
      const auth = { host: shop.host, token: who.token };
      expect(
        (
          await api("POST", `/v1/payments/${id}/confirm`, {
            ...auth,
            body: { receivedMinor: 30_000 },
          })
        ).status,
      ).toBe(403);
      expect((await api("GET", "/v1/payments", auth)).status).toBe(403);
    }
    expect(
      (
        await api("POST", `/v1/payments/${id}/confirm`, {
          host: shop.host,
          body: { receivedMinor: 30_000 },
        })
      ).status,
    ).toBe(401);
  });

  test("another barbershop can neither see nor resolve them", async () => {
    const shop = await transferShop();
    const other = await transferShop(OTHER_CLABE);
    const { id } = await pending(shop);

    expect<unknown>(
      (await api("GET", "/v1/payments", other.asOwner)).body,
    ).toEqual([]);
    expect((await confirm(other, id, { receivedMinor: 30_000 })).status).toBe(
      404,
    );
    expect(
      (
        await api("POST", `/v1/payments/${id}/reject`, {
          ...other.asOwner,
          body: {},
        })
      ).status,
    ).toBe(404);
    expect((await payments.findOne({ _id: new ObjectId(id) }))?.status).toBe(
      "pending",
    );
  });

  test("an expired transfer cannot be confirmed, and a new one can be requested", async () => {
    const shop = await transferShop();
    const { id, booking } = await pending(shop);
    await payments.updateOne(
      { _id: new ObjectId(id) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const res = await confirm(shop, id, { receivedMinor: 30_000 });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("INVALID_TRANSITION");
    expect((await payments.findOne({ _id: new ObjectId(id) }))?.status).toBe(
      "expired",
    );
    expect((await summary(booking.id))?.status).toBe("expired");

    const retry = await askTransfer(shop, {
      appointmentId: booking.id,
      paymentToken: booking.paymentToken,
    });
    expect(retry.status).toBe(201);
    expect(retry.body.id).not.toBe(id);
  });

  test("a cancelled appointment cannot be marked paid", async () => {
    const shop = await transferShop();
    const { id, booking } = await pending(shop);
    await appointments.updateOne(
      { _id: new ObjectId(booking.id) },
      { $set: { status: "cancelled" } },
    );
    const res = await confirm(shop, id, { receivedMinor: 30_000 });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("APPOINTMENT_NOT_PAYABLE");
  });
});
