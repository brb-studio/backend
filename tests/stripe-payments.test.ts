import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  appointments,
  notifications,
  payments,
  tenants,
} from "../src/db/collections";
import {
  api,
  bookingShop,
  createUser,
  dayIn,
  guestBooking,
  type Shop,
} from "./helpers";
import {
  type FakeStripe,
  fakeStripe,
  intentEvent,
  sendEvent,
  stripeShop,
} from "./stripe-fake";
import { at, DEPOSIT, paymentFlow } from "./stripe-flow";

let stripe: FakeStripe;
beforeEach(() => {
  stripe = fakeStripe();
});
afterEach(() => stripe.restore());

const { book, intentOf, status, appointmentOf, pay, expire } = paymentFlow(
  () => stripe,
);

const feeDebt = async (shop: Shop) =>
  (await tenants.findOne({ _id: shop.tenant._id }))?.stripeConnect
    ?.feeDebtMinor ?? 0;

describe("booking with an online payment", () => {
  test("a shop without an approved Stripe account books as before and refuses online payment", async () => {
    const shop = await bookingShop();
    const res = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00"), {
        payment: { kind: "full", method: "card" },
      }),
    });
    expect(res.body.error?.code).toBe("ONLINE_PAYMENT_UNAVAILABLE");
    const plain = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00")),
    });
    expect(plain.status).toBe(201);
    expect(plain.body.status).toBe("confirmed");
    expect(stripe.calls).toHaveLength(0);
  });

  test("a deposit shop requires paying, computes the amount itself and holds the slot", async () => {
    const shop = await stripeShop({ deposit: DEPOSIT });
    const startAt = at(shop, 2, "11:00");
    const unpaid = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(startAt),
    });
    expect(unpaid.body.error?.code).toBe("PAYMENT_REQUIRED");
    const priced = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(startAt, {
        payment: { kind: "deposit", method: "card", amountMinor: 1 },
      }),
    });
    expect(priced.status).toBe(422);

    const booked = await book(shop, startAt, {
      kind: "deposit",
      method: "card",
    });
    expect(booked.status).toBe("pending_payment");
    // 25% of 300.00 = 75.00; the rest is paid at the shop.
    expect(booked.checkout).toMatchObject({
      kind: "deposit",
      status: "pending",
      amountMinor: 7_500,
      balanceMinor: 22_500,
    });
    expect(booked.checkout.clientSecret).toBeString();
    const pi = await intentOf(booked);
    expect(pi).toMatchObject({
      amount: 7_500,
      currency: "mxn",
      method: "card",
      // 3.6% + 3.00 + IVA, so the shop absorbs Stripe's fee.
      application_fee_amount: 662,
      transfer_data: { destination: shop.tenant.stripeConnect?.accountId },
      metadata: { appointmentId: booked.id, kind: "deposit" },
    });

    const taken = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(startAt, {
        payment: { kind: "full", method: "card" },
      }),
    });
    expect(taken.body.error?.code).toBe("SLOT_TAKEN");
    const notified = await notifications.countDocuments({
      appointmentId: new ObjectId(booked.id),
    });
    expect(notified).toBe(0);
  });

  test("an expired hold frees the slot, gives the charge up and lets someone else book", async () => {
    const shop = await stripeShop();
    const startAt = at(shop, 2, "12:00");
    const booked = await book(shop, startAt, { kind: "full", method: "card" });
    const free = async () => {
      const res = await api(
        "GET",
        `/v1/public/availability?branch=centro&service=corte&barber=mateo&from=${dayIn(shop.timeZone, 2)}&days=1`,
        { host: shop.host },
      );
      const days =
        (res.body.barbers as { days: { slots: { startAt: string }[] }[] }[])[0]
          ?.days ?? [];
      return days
        .flatMap((d) => d.slots)
        .some((s) => s.startAt === new Date(startAt).toISOString());
    };
    expect(await free()).toBe(false);

    await expire(booked);
    expect(await free()).toBe(true);
    const next = await book(shop, startAt, { kind: "full", method: "card" });
    expect(next.status).toBe("pending_payment");
    const old = await appointmentOf(booked);
    expect(old).toMatchObject({
      status: "cancelled",
      cancelReason: "payment_expired",
      payment: { status: "expired" },
    });
    expect((await intentOf(booked)).status).toBe("canceled");
  });

  test("Stripe failing to create the charge releases the slot at once", async () => {
    const shop = await stripeShop();
    const startAt = at(shop, 2, "13:00");
    stripe.state.down = true;
    const res = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(startAt, {
        payment: { kind: "full", method: "card" },
      }),
    });
    expect(res.body.error?.code).toBe("PAYMENT_PROVIDER_ERROR");
    stripe.state.down = false;
    expect(
      (await book(shop, startAt, { kind: "full", method: "card" })).status,
    ).toBe("pending_payment");
  });
});

describe("the quote before paying", () => {
  test("gives each online option's amount and refund, as the booking will charge them", async () => {
    const shop = await stripeShop({ deposit: DEPOSIT });
    const res = await api("POST", "/v1/public/quote", {
      host: shop.host,
      body: { branch: "centro", service: "corte" },
    });
    expect(res.status).toBe(200);
    // 300.00: deposit 75.00; card fee (3.6% + 3.00) + IVA; transfer 7.00 + IVA.
    expect(res.body.online).toEqual({
      required: true,
      fullMinor: 30_000,
      depositMinor: 7_500,
      options: [
        {
          kind: "deposit",
          method: "card",
          amountMinor: 7_500,
          refundableMinor: 7_500 - 662,
        },
        {
          kind: "full",
          method: "card",
          amountMinor: 30_000,
          refundableMinor: 30_000 - 1_601,
        },
        {
          kind: "deposit",
          method: "bank_transfer",
          amountMinor: 7_500,
          refundableMinor: 7_500 - 812,
        },
        {
          kind: "full",
          method: "bank_transfer",
          amountMinor: 30_000,
          refundableMinor: 30_000 - 812,
        },
      ],
    });
    const booked = await book(shop, at(shop, 6, "11:00"), {
      kind: "deposit",
      method: "card",
    });
    expect(booked.checkout.refundableMinor).toBe(7_500 - 662);
  });

  test("a shop without online payments quotes as before", async () => {
    const shop = await bookingShop();
    const res = await api("POST", "/v1/public/quote", {
      host: shop.host,
      body: { branch: "centro", service: "corte" },
    });
    expect(res.body.online).toBeUndefined();
  });
});

describe("the payment webhook", () => {
  test("confirms the booking once, with the barber's notice and a clear ticket", async () => {
    const shop = await stripeShop({ deposit: DEPOSIT });
    const barberUser = await createUser(shop.tenant, "barber", {
      branchId: new ObjectId(shop.branchId),
    });
    const link = await api("PATCH", `/v1/barbers/${shop.barbers.mateo}`, {
      ...shop.asOwner,
      body: { userId: barberUser.user._id.toHexString() },
    });
    expect(link.status).toBe(200);
    const booked = await book(shop, at(shop, 2, "14:00"), {
      kind: "deposit",
      method: "card",
    });
    const pi = await pay(booked);
    await sendEvent(intentEvent("payment_intent.succeeded", pi));

    expect(await appointmentOf(booked)).toMatchObject({
      status: "confirmed",
      payment: { status: "paid", cardBrand: "visa", cardLast4: "4242" },
    });
    expect(
      await notifications.countDocuments({
        appointmentId: new ObjectId(booked.id),
        userId: barberUser.user._id,
      }),
    ).toBe(1);
    const ticket = await status(shop, booked);
    expect(ticket.body).toMatchObject({
      appointmentStatus: "confirmed",
      status: "paid",
      kind: "deposit",
      amountMinor: 7_500,
      balanceMinor: 22_500,
      cardLast4: "4242",
    });
    const agenda = await api(
      "GET",
      `/v1/appointments/${booked.id}`,
      shop.asOwner,
    );
    expect(agenda.body.payment).toMatchObject({
      method: "card",
      kind: "deposit",
      paidMinor: 7_500,
      balanceMinor: 22_500,
    });
  });

  test("a payment that arrives after its hold ended is refunded in full", async () => {
    const shop = await stripeShop();
    const booked = await book(shop, at(shop, 2, "15:00"), {
      kind: "full",
      method: "card",
    });
    await expire(booked);
    expect((await status(shop, booked)).body.appointmentStatus).toBe(
      "cancelled",
    );
    await pay(booked);
    expect(stripe.refunds).toEqual([
      { intent: (await intentOf(booked)).id, amount: 30_000, reverse: false },
    ]);
    // The shop gives back all it received; the platform absorbs its fee (nobody cancelled).
    expect(stripe.reversals.map((r) => r.amount)).toEqual([30_000 - 1_601]);
    expect(await feeDebt(shop)).toBe(0);
    expect(
      await payments.findOne({ _id: new ObjectId(booked.checkout.paymentId) }),
    ).toMatchObject({ status: "refunded", stripe: { refundedMinor: 30_000 } });
    expect((await appointmentOf(booked))?.status).toBe("cancelled");
  });

  test("a chargeback marks the payment and tells owners and admins", async () => {
    const shop = await stripeShop();
    const booked = await book(shop, at(shop, 2, "16:00"), {
      kind: "full",
      method: "card",
    });
    const pi = await pay(booked);
    const res = await sendEvent({
      id: `evt_dispute_${booked.id}`,
      object: "event",
      type: "charge.dispute.created",
      data: {
        object: {
          id: "du_test1",
          amount: 30_000,
          charge: pi.latest_charge?.id,
          payment_intent: pi.id,
        },
      },
    });
    expect(res.status).toBe(200);
    expect((await appointmentOf(booked))?.payment?.status).toBe("disputed");
    expect(
      await notifications.countDocuments({
        userId: shop.owner.user._id,
        type: "payment.disputed",
      }),
    ).toBe(1);
  });

  test("guests need their booking token to see the payment", async () => {
    const shop = await stripeShop();
    const booked = await book(shop, at(shop, 3, "11:00"), {
      kind: "full",
      method: "card",
    });
    const res = await api(
      "GET",
      `/v1/public/appointments/${booked.id}/payment`,
      {
        host: shop.host,
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("bank transfer through Stripe", () => {
  test("shows Stripe's CLABE and confirms only when the whole amount arrived", async () => {
    const shop = await stripeShop({ deposit: DEPOSIT });
    const booked = await book(shop, at(shop, 2, "11:30"), {
      kind: "deposit",
      method: "bank_transfer",
    });
    expect(booked.checkout).toMatchObject({
      status: "awaiting_transfer",
      amountMinor: 7_500,
      transfer: { clabe: "002180650612345670", amountRemainingMinor: 7_500 },
    });
    expect(booked.checkout.clientSecret).toBeUndefined();
    const pi = await intentOf(booked);
    expect(pi.customer).toStartWith("cus_");
    // 7.00 + IVA per transfer.
    expect(pi.application_fee_amount).toBe(812);

    stripe.fund(pi.id, 5_000);
    await sendEvent(intentEvent("payment_intent.partially_funded", pi));
    const partial = await status(shop, booked);
    expect(partial.body).toMatchObject({
      appointmentStatus: "pending_payment",
      transfer: { amountRemainingMinor: 2_500 },
    });

    await pay(booked);
    const paid = await appointmentOf(booked);
    expect(paid?.status).toBe("confirmed");
    // The ticket says transfer, never a card.
    expect(paid?.payment).toMatchObject({
      method: "bank_transfer",
      status: "paid",
    });
    expect(paid?.payment?.cardLast4).toBeUndefined();
    const ticket = await status(shop, booked);
    expect(ticket.body).toMatchObject({
      method: "bank_transfer",
      status: "paid",
    });
    expect(ticket.body.cardLast4).toBeUndefined();
  });

  test("switching card → transfer cancels the first charge; too close to the visit it is refused", async () => {
    const shop = await stripeShop();
    const booked = await book(shop, at(shop, 2, "12:30"), {
      kind: "full",
      method: "card",
    });
    const card = await intentOf(booked);
    const sw = (body: Record<string, unknown>) =>
      api("POST", `/v1/public/appointments/${booked.id}/payment`, {
        host: shop.host,
        body: { ...body, paymentToken: booked.paymentToken },
      });
    const switched = await sw({ kind: "full", method: "bank_transfer" });
    expect(switched.status).toBe(201);
    expect(switched.body).toMatchObject({ status: "awaiting_transfer" });
    expect(stripe.intent(card.id).status).toBe("canceled");

    await appointments.updateOne(
      { _id: new ObjectId(booked.id) },
      { $set: { startAt: new Date(Date.now() + 10 * 60_000) } },
    );
    expect(
      (await sw({ kind: "full", method: "bank_transfer" })).body.error?.code,
    ).toBe("TRANSFER_TOO_LATE");
  });
});
