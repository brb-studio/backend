import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { app } from "../src/app";
import { stripeEvents, tenants } from "../src/db/collections";
import { signPayload } from "../src/features/payments/stripe/signature";
import { api, bookingShop, createUser } from "./helpers";
import {
  type FakeStripe,
  fakeStripe,
  sendEvent,
  stripeShop,
} from "./stripe-fake";

let stripe: FakeStripe;
beforeEach(() => {
  stripe = fakeStripe();
});
afterEach(() => stripe.restore());

const accountEvent = (accountId: string) => ({
  id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
  object: "v2.core.event",
  type: "v2.core.account[configuration.recipient].capability_status_updated",
  related_object: {
    id: accountId,
    type: "v2.core.account",
    url: `/v2/core/accounts/${accountId}`,
  },
});

describe("connected account", () => {
  test("the owner gets Stripe's form; the account is created once and the link back is the shop's own page", async () => {
    const shop = await bookingShop();
    const start = () =>
      api("POST", "/v1/payments/stripe/onboarding", {
        ...shop.asOwner,
        body: { locale: "es" },
      });
    const first = await start();
    expect(first.status).toBe(200);
    expect(first.body.url).toBe("https://connect.stripe.com/setup/test");
    expect((await start()).status).toBe(200);
    expect(
      stripe.calls.filter((c) => c.path === "/v2/core/accounts"),
    ).toHaveLength(1);

    const saved = await tenants.findOne({ _id: shop.tenant._id });
    expect(saved?.stripeConnect).toMatchObject({
      status: "onboarding",
      requirementsDue: [],
    });
    const view = await api("GET", "/v1/payments/stripe", shop.asOwner);
    expect(view.body).toMatchObject({ available: true, status: "onboarding" });
    expect(JSON.stringify(view.body)).not.toContain("acct_");
  });

  test("only owner and admin connect Stripe", async () => {
    const shop = await bookingShop();
    const manager = await createUser(shop.tenant, "manager");
    const res = await api("POST", "/v1/payments/stripe/onboarding", {
      host: shop.host,
      token: manager.token,
      body: {},
    });
    expect(res.status).toBe(403);
    expect(stripe.calls).toHaveLength(0);
  });

  test("Stripe's account event moves the shop to active, reading the account from Stripe", async () => {
    const shop = await bookingShop();
    await api("POST", "/v1/payments/stripe/onboarding", {
      ...shop.asOwner,
      body: {},
    });
    const accountId = String(
      (await tenants.findOne({ _id: shop.tenant._id }))?.stripeConnect
        ?.accountId,
    );

    stripe.accounts.set(accountId, { transfers: "restricted", due: ["tos"] });
    expect((await sendEvent(accountEvent(accountId))).status).toBe(200);
    expect(
      (await tenants.findOne({ _id: shop.tenant._id }))?.stripeConnect,
    ).toMatchObject({ status: "onboarding", requirementsDue: ["tos"] });

    stripe.accounts.set(accountId, { transfers: "active", due: [] });
    expect((await sendEvent(accountEvent(accountId))).status).toBe(200);
    expect(
      (await tenants.findOne({ _id: shop.tenant._id }))?.stripeConnect,
    ).toMatchObject({ status: "active", requirementsDue: [] });

    const publicView = await api("GET", "/v1/public/tenant", {
      host: shop.host,
    });
    expect(publicView.body.payments).toMatchObject({
      online: true,
      deposit: { enabled: false },
    });
  });

  test("the Express dashboard link needs a finished registration", async () => {
    const shop = await bookingShop();
    expect(
      (await api("POST", "/v1/payments/stripe/dashboard", shop.asOwner)).body
        .error?.code,
    ).toBe("ONBOARDING_INCOMPLETE");
    const active = await stripeShop();
    const res = await api(
      "POST",
      "/v1/payments/stripe/dashboard",
      active.asOwner,
    );
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://connect.stripe.com/express/test");
  });

  test("Stripe being down is a 502 with a stable code, not a crash", async () => {
    const shop = await bookingShop();
    stripe.state.down = true;
    const res = await api("POST", "/v1/payments/stripe/onboarding", {
      ...shop.asOwner,
      body: {},
    });
    expect(res.status).toBe(502);
    expect(res.body.error?.code).toBe("PAYMENT_PROVIDER_ERROR");
  });
});

describe("deposit settings", () => {
  test("owner sets a percentage; out-of-range or extra keys are refused", async () => {
    const shop = await stripeShop();
    const save = (body: Record<string, unknown>) =>
      api("PATCH", "/v1/payments/deposit", { ...shop.asOwner, body });
    expect((await save({ enabled: true, percentBps: 50 })).status).toBe(422);
    expect((await save({ enabled: true, percentBps: 10_001 })).status).toBe(
      422,
    );
    expect(
      (await save({ enabled: true, percentBps: 2_500, amountMinor: 1 })).status,
    ).toBe(422);
    const ok = await save({ enabled: true, percentBps: 2_500 });
    expect(ok.body).toEqual({ enabled: true, percentBps: 2_500 });
    const view = await api("GET", "/v1/public/tenant", { host: shop.host });
    expect(view.body.payments).toMatchObject({
      online: true,
      deposit: { enabled: true, percentBps: 2_500 },
      holdMinutes: { card: 20, bank_transfer: 60 },
    });
  });
});

describe("webhook", () => {
  const post = (payload: string, signature?: string) =>
    app.request("/webhooks/stripe", {
      method: "POST",
      headers: signature ? { "Stripe-Signature": signature } : {},
      body: payload,
    });

  test("a bad or missing signature is a 400 and nothing is processed", async () => {
    const payload = JSON.stringify(accountEvent("acct_x"));
    const t = Math.floor(Date.now() / 1000);
    expect((await post(payload)).status).toBe(400);
    expect(
      (
        await post(
          payload,
          `t=${t},v1=${signPayload(payload, "whsec_other", t)}`,
        )
      ).status,
    ).toBe(400);
    const old = t - 3_600;
    expect(
      (
        await post(
          payload,
          `t=${old},v1=${signPayload(payload, "whsec_test", old)}`,
        )
      ).status,
    ).toBe(400);
    expect(stripe.calls).toHaveLength(0);
  });

  test("a redelivered event is acknowledged without being handled again", async () => {
    const shop = await stripeShop();
    const accountId = String(shop.tenant.stripeConnect?.accountId);
    const event = accountEvent(accountId);
    expect((await sendEvent(event)).body).toEqual({ received: true });
    expect(await stripeEvents.countDocuments({ _id: event.id })).toBe(1);
    const reads = stripe.calls.length;
    expect((await sendEvent(event)).body).toEqual({
      received: true,
      duplicate: true,
    });
    expect(stripe.calls.length).toBe(reads);
  });

  test("events about objects that aren't ours are acknowledged and ignored", async () => {
    const res = await sendEvent({
      id: "evt_unknown_intent",
      object: "event",
      type: "charge.dispute.created",
      data: { object: { id: "du_1", amount: 100, charge: "ch_1" } },
    });
    expect(res.status).toBe(200);
  });
});
