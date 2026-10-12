import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tenants } from "../src/db/collections";
import { api, guestBooking, type Shop } from "./helpers";
import { type FakeStripe, fakeStripe, stripeShop } from "./stripe-fake";
import { at, type DEPOSIT, paymentFlow } from "./stripe-flow";

let stripe: FakeStripe;
beforeEach(() => {
  stripe = fakeStripe();
});
afterEach(() => stripe.restore());

const { book, intentOf, pay, expire, status } = paymentFlow(() => stripe);

const dollarShop = (deposit?: typeof DEPOSIT) =>
  stripeShop(deposit ? { deposit } : {}, { tenant: { currency: "USD" } });

const feeDebt = async (shop: Shop) =>
  (await tenants.findOne({ _id: shop.tenant._id }))?.stripeConnect;

// A card charge of 300.00 USD keeps 6.1% (3.6% + 0.5% foreign card + 2% conversion) + 0.20 + IVA = 21.46.
const USD_FEE = 2_146;

describe("a barbershop charging in dollars", () => {
  test("takes cards and Link only, never Mexican bank transfers", async () => {
    const shop = await dollarShop();
    const view = await api("GET", "/v1/public/tenant", { host: shop.host });
    expect(view.body.payments).toMatchObject({
      online: true,
      methods: ["card"],
    });
    const transfer = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(at(shop, 2, "11:00"), {
        payment: { kind: "full", method: "bank_transfer" },
      }),
    });
    expect(transfer.body.error?.code).toBe("METHOD_UNAVAILABLE");
    expect(stripe.intents.size).toBe(0);

    const booked = await book(shop, at(shop, 2, "11:00"), {
      kind: "full",
      method: "card",
    });
    const pi = await intentOf(booked);
    expect(pi).toMatchObject({
      currency: "usd",
      amount: 30_000,
      allowed: ["card", "link"],
      application_fee_amount: USD_FEE,
    });
    expect(booked.checkout.refundableMinor).toBe(30_000 - USD_FEE);

    const sw = await api(
      "POST",
      `/v1/public/appointments/${booked.id}/payment`,
      {
        host: shop.host,
        body: {
          kind: "full",
          method: "bank_transfer",
          paymentToken: booked.paymentToken,
        },
      },
    );
    expect(sw.body.error?.code).toBe("METHOD_UNAVAILABLE");
    // Refusing the switch never cancels the card payment the customer is making.
    expect(stripe.intent(pi.id).status).toBe("requires_payment_method");
  });

  test("the deposit rounds up to the whole dollar", async () => {
    const shop = await dollarShop({ enabled: true, percentBps: 2_250 });
    const booked = await book(shop, at(shop, 2, "12:00"), {
      kind: "deposit",
      method: "card",
    });
    // 22.5% of 300.00 = 67.50 → 68.00
    expect(booked.checkout).toMatchObject({
      kind: "deposit",
      amountMinor: 6_800,
      balanceMinor: 23_200,
    });
  });

  test("its fee debt is kept in dollars and only collected by dollar payments", async () => {
    const shop = await dollarShop();
    const booked = await book(shop, at(shop, 3, "11:00"), {
      kind: "full",
      method: "card",
    });
    await pay(booked);
    const refund = await api(
      "POST",
      `/v1/payments/appointments/${booked.id}/refund`,
      { ...shop.asOwner, body: {} },
    );
    expect(refund.status).toBe(200);
    expect(await feeDebt(shop)).toMatchObject({
      feeDebtMinor: USD_FEE,
      feeDebtCurrency: "USD",
    });
    const view = await api("GET", "/v1/payments/stripe", shop.asOwner);
    expect(view.body).toMatchObject({
      feeDebtMinor: USD_FEE,
      feeDebtCurrency: "USD",
      currency: "USD",
    });

    const next = await book(shop, at(shop, 3, "13:00"), {
      kind: "full",
      method: "card",
    });
    expect((await intentOf(next)).application_fee_amount).toBe(USD_FEE * 2);
    expect((await feeDebt(shop))?.feeDebtMinor).toBe(0);
    await expire(next);
    await status(shop, next);
    expect(await feeDebt(shop)).toMatchObject({
      feeDebtMinor: USD_FEE,
      feeDebtCurrency: "USD",
    });
  });

  test("a debt left in pesos is never collected from dollar payments", async () => {
    const shop = await dollarShop();
    await tenants.updateOne(
      { _id: shop.tenant._id },
      {
        $set: {
          "stripeConnect.feeDebtMinor": 500,
          "stripeConnect.feeDebtCurrency": "MXN",
        },
      },
    );
    const booked = await book(shop, at(shop, 4, "11:00"), {
      kind: "full",
      method: "card",
    });
    expect((await intentOf(booked)).application_fee_amount).toBe(USD_FEE);
    expect(await feeDebt(shop)).toMatchObject({
      feeDebtMinor: 500,
      feeDebtCurrency: "MXN",
    });
  });
});
