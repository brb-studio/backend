import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { appointments, tenants } from "../src/db/collections";
import { api, createUser, type Shop } from "./helpers";
import { type FakeStripe, fakeStripe, stripeShop } from "./stripe-fake";
import { at, type Booked, paymentFlow } from "./stripe-flow";

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

// A card charge of 300.00 keeps 16.01 (3.6% + 3.00 + IVA): the shop's transfer is 283.99.
const FEE = 1_601;

describe("refunds", () => {
  async function paidAsCustomer(shop: Shop) {
    const customer = await createUser(shop.tenant, "customer");
    const res = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      token: customer.token,
      body: {
        branch: "centro",
        barber: "mateo",
        service: "corte",
        startAt: at(shop, 3, "15:00"),
        payment: { kind: "full", method: "card" },
      },
    });
    expect(res.status).toBe(201);
    const booked = res.body as unknown as Booked;
    await pay(booked);
    return { customer, booked };
  }

  test("the customer cancelling in time gets it back minus Stripe's fee, shown before paying", async () => {
    const shop = await stripeShop();
    const { customer, booked } = await paidAsCustomer(shop);
    expect(booked.checkout.refundableMinor).toBe(30_000 - FEE);
    const mine = await api("GET", "/v1/me/appointments", {
      host: shop.host,
      token: customer.token,
    });
    expect(
      (mine.body as unknown as { payment: { refundableMinor: number } }[])[0]
        ?.payment.refundableMinor,
    ).toBe(30_000 - FEE);
    const res = await api("POST", `/v1/me/appointments/${booked.id}/cancel`, {
      host: shop.host,
      token: customer.token,
    });
    expect(res.status).toBe(204);
    expect(stripe.refunds.map((r) => r.amount)).toEqual([30_000 - FEE]);
    // The shop returns exactly what the customer got: the fee was the customer's to pay.
    expect(stripe.reversals.map((r) => r.amount)).toEqual([30_000 - FEE]);
    expect(await feeDebt(shop)).toBe(0);
    expect((await appointmentOf(booked))?.payment).toMatchObject({
      status: "paid",
      refundedMinor: 30_000 - FEE,
    });
  });

  test("the barbershop cancelling returns the whole payment, even at the last minute", async () => {
    const shop = await stripeShop();
    const { booked } = await paidAsCustomer(shop);
    await appointments.updateOne(
      { _id: new ObjectId(booked.id) },
      { $set: { startAt: new Date(Date.now() + 5 * 60_000) } },
    );
    const res = await api("PATCH", `/v1/appointments/${booked.id}`, {
      ...shop.asOwner,
      body: { status: "cancelled", cancelReason: "Barbero enfermo" },
    });
    expect(res.status).toBe(200);
    expect(stripe.refunds.map((r) => r.amount)).toEqual([30_000]);
    // The shop returns its whole transfer and owes the platform the fee it kept.
    expect(stripe.reversals.map((r) => r.amount)).toEqual([30_000 - FEE]);
    expect(await feeDebt(shop)).toBe(FEE);
    const view = await api("GET", "/v1/payments/stripe", shop.asOwner);
    expect(view.body).toMatchObject({ feeDebtMinor: FEE, currency: "MXN" });
  });

  test("the fee debt is collected on the next payment, and comes back if that one isn't paid", async () => {
    const shop = await stripeShop();
    await tenants.updateOne(
      { _id: shop.tenant._id },
      { $set: { "stripeConnect.feeDebtMinor": 500 } },
    );
    const booked = await book(shop, at(shop, 5, "12:00"), {
      kind: "full",
      method: "card",
    });
    expect((await intentOf(booked)).application_fee_amount).toBe(FEE + 500);
    expect(await feeDebt(shop)).toBe(0);
    // The customer only ever loses Stripe's fee, never the shop's debt.
    expect(booked.checkout.refundableMinor).toBe(30_000 - FEE);
    await expire(booked);
    await status(shop, booked);
    expect(await feeDebt(shop)).toBe(500);
  });

  test("owners refund part or all from the appointment; never more than was paid", async () => {
    const shop = await stripeShop();
    const { booked } = await paidAsCustomer(shop);
    const refund = (amountMinor?: number) =>
      api("POST", `/v1/payments/appointments/${booked.id}/refund`, {
        ...shop.asOwner,
        body: amountMinor === undefined ? {} : { amountMinor },
      });
    expect((await refund(40_000)).body.error?.code).toBe("REFUND_TOO_LARGE");
    const part = await refund(10_000);
    expect(part.status).toBe(200);
    expect(part.body.status).toBe("paid");
    const rest = await refund();
    expect(rest.body.status).toBe("refunded");
    expect(stripe.refunds.map((r) => r.amount)).toEqual([10_000, 20_000]);
    // 100.00 comes from the shop; of the last 200.00 its transfer covers 183.99.
    expect(stripe.reversals.map((r) => r.amount)).toEqual([
      10_000,
      20_000 - FEE,
    ]);
    expect(await feeDebt(shop)).toBe(FEE);
  });

  test("a guest giving up an unpaid booking frees the slot without any refund", async () => {
    const shop = await stripeShop();
    const customer = await createUser(shop.tenant, "customer");
    const startAt = at(shop, 4, "11:00");
    const res = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      token: customer.token,
      body: {
        branch: "centro",
        barber: "mateo",
        service: "corte",
        startAt,
        payment: { kind: "full", method: "card" },
      },
    });
    const booked = res.body as unknown as Booked;
    const cancel = await api(
      "POST",
      `/v1/me/appointments/${booked.id}/cancel`,
      {
        host: shop.host,
        token: customer.token,
      },
    );
    expect(cancel.status).toBe(204);
    expect((await appointmentOf(booked))?.cancelReason).toBe(
      "cancelled_by_customer",
    );
    expect(stripe.refunds).toHaveLength(0);
    expect(
      (await book(shop, startAt, { kind: "full", method: "card" })).status,
    ).toBe("pending_payment");
  });
});
