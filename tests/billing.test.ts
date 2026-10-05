import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { ObjectId } from "mongodb";
import Stripe from "stripe";
import { app } from "../src/app";
import { config } from "../src/config";
import { referrals, tenants, users } from "../src/db/collections";
import { requireStripe } from "../src/features/payments/stripe";
import { api, createShop, createUser } from "./helpers";

type Shop = Awaited<ReturnType<typeof createShop>>;
type Params = Record<string, unknown>;

/**
 * Stripe on for this file only: other suites (booking) rely on payments being off. Every SDK call
 * billing makes is stubbed below, so nothing leaves the machine.
 */
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  STRIPE_SUBSCRIPTION_PRICE: "price_monthly",
} as const;
const saved: Partial<typeof config> = {};
beforeAll(() => {
  for (const key of Object.keys(STRIPE_ENV) as (keyof typeof STRIPE_ENV)[]) {
    saved[key] = config[key];
    config[key] = STRIPE_ENV[key];
  }
});
afterAll(() => Object.assign(config, saved));

/** In-memory Stripe: the resources billing uses, with Stripe's idempotency-key behavior. */
function fakeStripe() {
  const stripe = requireStripe();
  let seq = 0;
  const next = (prefix: string) =>
    `${prefix}_${++seq}x${Date.now().toString(36)}`;
  const state = {
    customers: new Map<string, { id: string; balance: number }>(),
    subscriptions: new Map<string, Params>(),
    coupons: new Set<string>(),
    checkouts: [] as Params[],
    credits: [] as Params[],
    idempotent: new Map<string, unknown>(),
  };
  const once = <T>(key: string | undefined, make: () => T): T => {
    if (key && state.idempotent.has(key)) return state.idempotent.get(key) as T;
    const value = make();
    if (key) state.idempotent.set(key, value);
    return value;
  };
  type Options = { idempotencyKey?: string } | undefined;
  const stubs = [
    spyOn(stripe.customers, "create").mockImplementation((async (
      _params: Params,
      options: Options,
    ) =>
      once(options?.idempotencyKey, () => {
        const customer = { id: next("cus"), balance: 0 };
        state.customers.set(customer.id, customer);
        return customer;
      })) as never),
    spyOn(stripe.customers, "retrieve").mockImplementation((async (
      id: string,
    ) => {
      const customer = state.customers.get(id);
      if (!customer) throw new Error(`no customer ${id}`);
      return { ...customer, deleted: undefined };
    }) as never),
    spyOn(stripe.customers, "createBalanceTransaction").mockImplementation(
      (async (id: string, params: Params, options: Options) =>
        once(options?.idempotencyKey, () => {
          const customer = state.customers.get(id);
          if (!customer) throw new Error(`no customer ${id}`);
          customer.balance += Number(params.amount);
          state.credits.push({ customer: id, ...params });
          return { id: next("cbtxn") };
        })) as never,
    ),
    spyOn(stripe.coupons, "create").mockImplementation((async (
      params: Params,
    ) => {
      const id = String(params.id);
      if (state.coupons.has(id)) {
        throw new Stripe.errors.StripeInvalidRequestError({
          type: "invalid_request_error",
          code: "resource_already_exists",
          message: "Coupon already exists.",
        });
      }
      state.coupons.add(id);
      return { id };
    }) as never),
    spyOn(stripe.checkout.sessions, "create").mockImplementation((async (
      params: Params,
    ) => {
      state.checkouts.push(params);
      const id = next("cs");
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    }) as never),
    spyOn(stripe.billingPortal.sessions, "create").mockImplementation(
      (async () => ({
        url: "https://billing.stripe.com/p/session/test",
      })) as never,
    ),
    spyOn(stripe.prices, "retrieve").mockImplementation((async (
      id: string,
    ) => ({
      id,
      unit_amount: 30_000,
      currency: "mxn",
      recurring: { interval: "month" },
    })) as never),
    spyOn(stripe.subscriptions, "retrieve").mockImplementation((async (
      id: string,
    ) => {
      const sub = state.subscriptions.get(id);
      if (!sub) throw new Error(`no subscription ${id}`);
      return sub;
    }) as never),
  ];
  return {
    state,
    restore: () => {
      for (const stub of stubs) stub.mockRestore();
    },
    subscribe(customer: string, price: string) {
      const id = next("sub");
      state.subscriptions.set(id, {
        id,
        customer,
        status: "active",
        metadata: {},
        items: {
          data: [
            {
              price: { id: price },
              current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
            },
          ],
        },
      });
      return id;
    },
    setStatus(id: string, status: string) {
      const sub = state.subscriptions.get(id);
      if (sub) sub.status = status;
    },
    /** What the customer portal does on "Cancel": active until `at` (seconds), or `null` to undo. */
    setCancelAt(id: string, at: number | null) {
      const sub = state.subscriptions.get(id);
      if (sub) sub.cancel_at = at;
    },
  };
}

let stripe: ReturnType<typeof fakeStripe>;
beforeEach(() => {
  stripe = fakeStripe();
});
afterEach(() => stripe.restore());

async function webhook(
  type: string,
  object: Params,
  secret: string = STRIPE_ENV.STRIPE_WEBHOOK_SECRET,
) {
  const payload = JSON.stringify({
    id: `evt_${Date.now()}`,
    object: "event",
    type,
    data: { object },
  });
  const res = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: {
      "Stripe-Signature":
        await requireStripe().webhooks.generateTestHeaderStringAsync({
          payload,
          secret,
        }),
    },
    body: payload,
  });
  return {
    status: res.status,
    body: (await res.json()) as { error?: { code: string } },
  };
}

type Summary = {
  plan: string;
  status: string;
  subscribed: boolean;
  cancelAt?: string;
  creditMinor: number;
  referral: {
    code: string | null;
    referred: number;
    rewarded: number;
    earnedMinor: number;
  };
  referredBy?: { discountPercent: number };
};

const summary = async (shop: Shop) =>
  (await api("GET", "/v1/billing", shop.asOwner)).body as unknown as Summary;

const returnUrl = (shop: { host: string }) =>
  `http://${shop.host}:3000/es/admin/account`;

/** The owner checks out, then Stripe reports the first month paid. */
async function pay(shop: Shop, options: { referralCode?: string } = {}) {
  const res = await api("POST", "/v1/billing/checkout", {
    ...shop.asOwner,
    body: {
      returnUrl: returnUrl(shop),
      ...(options.referralCode && { referralCode: options.referralCode }),
    },
  });
  if (res.status !== 201)
    throw new Error(`checkout: ${res.status} ${JSON.stringify(res.body)}`);
  const checkout = stripe.state.checkouts.at(-1) as {
    customer: string;
    client_reference_id: string;
    line_items: { price: string }[];
    metadata: Record<string, string>;
    discounts?: { coupon: string }[];
  };
  const subscription = stripe.subscribe(
    checkout.customer,
    checkout.line_items[0]?.price ?? "",
  );
  const session = {
    id: `cs_${shop.tenant._id}`,
    object: "checkout.session",
    mode: "subscription",
    payment_status: "paid",
    client_reference_id: checkout.client_reference_id,
    customer: checkout.customer,
    subscription,
    currency: "mxn",
    amount_subtotal: 30_000,
    metadata: checkout.metadata,
  };
  const hook = await webhook("checkout.session.completed", session);
  expect(hook.status).toBe(200);
  return { checkout, session, subscription };
}

const tenantDoc = (id: ObjectId) => tenants.findOne({ _id: id });

describe("billing", () => {
  test("only the owner sees billing; before paying there is no code to share", async () => {
    const shop = await createShop({
      subscription: {
        plan: "trial",
        status: "trialing",
        limits: { branches: 1, barbers: 3 },
      },
    });
    const admin = await createUser(shop.tenant, "admin");
    const forbidden = await api("GET", "/v1/billing", {
      host: shop.host,
      token: admin.token,
    });
    expect(forbidden.status).toBe(403);
    expect(await summary(shop)).toMatchObject({
      plan: "trial",
      status: "trialing",
      subscribed: false,
      price: { amountMinor: 30_000, currency: "MXN", interval: "month" },
      creditMinor: 0,
      referral: {
        code: null,
        friendPercent: 20,
        rewardPercent: 10,
        referred: 0,
      },
    });
  });

  test("checkout opens a Stripe subscription for the plan's price, returning to the tenant's own site", async () => {
    const shop = await createShop();
    const res = await api("POST", "/v1/billing/checkout", {
      ...shop.asOwner,
      body: { returnUrl: returnUrl(shop) },
    });
    expect(res.status).toBe(201);
    expect(String(res.body.url)).toStartWith("https://checkout.stripe.com/");
    expect(stripe.state.checkouts[0]).toMatchObject({
      mode: "subscription",
      line_items: [{ price: "price_monthly", quantity: 1 }],
      client_reference_id: shop.tenant._id.toHexString(),
      success_url: `${returnUrl(shop)}?checkout=success`,
    });
    expect(stripe.state.checkouts[0]?.discounts).toBeUndefined();
    expect((await tenantDoc(shop.tenant._id))?.billing?.stripeCustomerId).toBe(
      String(stripe.state.checkouts[0]?.customer),
    );

    const elsewhere = await api("POST", "/v1/billing/checkout", {
      ...shop.asOwner,
      body: { returnUrl: "https://evil.example.com/" },
    });
    expect(elsewhere.status).toBe(422);
  });

  test("a paid checkout activates the plan, hands out a referral code and blocks a second checkout", async () => {
    const shop = await createShop({
      subscription: {
        plan: "trial",
        status: "trialing",
        currentPeriodEnd: new Date(Date.now() - 864e5),
        limits: { branches: 1, barbers: 3 },
      },
    });
    await pay(shop);
    const tenant = await tenantDoc(shop.tenant._id);
    expect(tenant?.subscription).toMatchObject({
      plan: "pro",
      status: "active",
      limits: { branches: 5 },
    });
    expect(tenant?.subscription.currentPeriodEnd?.getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(tenant?.billing?.firstPaidAt).toBeInstanceOf(Date);

    const code = (await summary(shop)).referral.code;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect((await summary(shop)).referral.code).toBe(code);

    const again = await api("POST", "/v1/billing/checkout", {
      ...shop.asOwner,
      body: { returnUrl: returnUrl(shop) },
    });
    expect(again.body.error?.code).toBe("ALREADY_SUBSCRIBED");
  });

  test("referral: the friend gets 20% off the first month, the referrer 10% of it as stacking credit", async () => {
    const referrer = await createShop();
    await pay(referrer);
    const code = String((await summary(referrer)).referral.code);

    const friends = [await createShop(), await createShop()];
    for (const friend of friends) {
      const check = await api("POST", "/v1/billing/referral-check", {
        ...friend.asOwner,
        body: { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` },
      });
      expect(check.body).toEqual({ code, discountPercent: 20 });
      const { checkout } = await pay(friend, { referralCode: code });
      expect(checkout.discounts).toEqual([{ coupon: "brb-referral-20" }]);
      expect(checkout.metadata.referrerTenantId).toBe(
        referrer.tenant._id.toHexString(),
      );
    }
    expect(stripe.state.coupons.size).toBe(1);

    const totals = await summary(referrer);
    expect(totals.referral).toMatchObject({
      referred: 2,
      rewarded: 2,
      earnedMinor: 6_000,
    });
    expect(totals.creditMinor).toBe(6_000);
    expect(stripe.state.credits.map((c) => [c.amount, c.currency])).toEqual([
      [-3000, "mxn"],
      [-3000, "mxn"],
    ]);
    expect((await summary(friends[0] as Shop)).referredBy).toEqual({
      discountPercent: 20,
    });
  });

  test("a retried webhook credits the referrer only once", async () => {
    const referrer = await createShop();
    await pay(referrer);
    const code = String((await summary(referrer)).referral.code);
    const friend = await createShop();
    const { session } = await pay(friend, { referralCode: code });
    expect((await webhook("checkout.session.completed", session)).status).toBe(
      200,
    );
    expect(stripe.state.credits).toHaveLength(1);
    expect(
      await referrals.countDocuments({ refereeTenantId: friend.tenant._id }),
    ).toBe(1);
    expect((await summary(referrer)).creditMinor).toBe(3_000);
  });

  test("codes are refused for yourself, the same owner, after the first month, or when unknown", async () => {
    const referrer = await createShop();
    await pay(referrer);
    const code = String((await summary(referrer)).referral.code);
    const check = (shop: Shop, value = code) =>
      api("POST", "/v1/billing/referral-check", {
        ...shop.asOwner,
        body: { code: value },
      });

    expect((await check(referrer)).body.error?.code).toBe("REFERRAL_SELF");

    const sameOwner = await createShop();
    await users.updateOne(
      { _id: sameOwner.owner.user._id },
      { $set: { email: referrer.owner.user.email } },
    );
    expect((await check(sameOwner)).body.error?.code).toBe("REFERRAL_SELF");

    const payer = await createShop();
    await pay(payer);
    expect((await check(payer)).body.error?.code).toBe("REFERRAL_NOT_FIRST");

    const unknown = await check(await createShop(), "ZZZZZZZZ");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error?.code).toBe("REFERRAL_NOT_FOUND");
    expect((await check(payer, "nope")).status).toBe(422);

    const unpaid = await createShop();
    const checkout = await api("POST", "/v1/billing/checkout", {
      ...unpaid.asOwner,
      body: {
        returnUrl: returnUrl(unpaid),
        referralCode: "ZZZZZZZZ",
      },
    });
    expect(checkout.status).toBe(404);
    expect(stripe.state.checkouts).toHaveLength(2);
  });

  test("cancelling from the portal keeps it active until the period ends; reactivating undoes it", async () => {
    const shop = await createShop();
    const { subscription } = await pay(shop);
    const end = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const updated = () =>
      webhook("customer.subscription.updated", {
        id: subscription,
        object: "subscription",
      });

    stripe.setCancelAt(subscription, end);
    expect((await updated()).status).toBe(200);
    const cancelling = await summary(shop);
    expect(cancelling).toMatchObject({ status: "active", subscribed: true });
    expect(cancelling.cancelAt).toBe(new Date(end * 1000).toISOString());
    const write = await api("PATCH", "/v1/tenant", {
      ...shop.asOwner,
      body: { name: "Sigue activa" },
    });
    expect(write.status).toBe(200);

    stripe.setCancelAt(subscription, null);
    expect((await updated()).status).toBe(200);
    expect((await summary(shop)).cancelAt).toBeUndefined();

    stripe.setCancelAt(subscription, end);
    await updated();
    stripe.setStatus(subscription, "canceled");
    await webhook("customer.subscription.deleted", {
      id: subscription,
      object: "subscription",
    });
    const ended = await summary(shop);
    expect(ended).toMatchObject({ status: "canceled", subscribed: false });
    expect(ended.cancelAt).toBeUndefined();
  });

  test("Stripe ending the subscription locks writes (402); the owner can still reach billing", async () => {
    const shop = await createShop();
    const { subscription } = await pay(shop);
    stripe.setStatus(subscription, "canceled");
    const hook = await webhook("customer.subscription.deleted", {
      id: subscription,
      object: "subscription",
    });
    expect(hook.status).toBe(200);
    expect((await tenantDoc(shop.tenant._id))?.subscription.status).toBe(
      "canceled",
    );
    const write = await api("PATCH", "/v1/tenant", {
      ...shop.asOwner,
      body: { name: "Nueva" },
    });
    expect(write.body.error?.code).toBe("SUBSCRIPTION_INACTIVE");
    expect((await api("GET", "/v1/billing", shop.asOwner)).status).toBe(200);
    const portal = await api("POST", "/v1/billing/portal", {
      ...shop.asOwner,
      body: { returnUrl: returnUrl(shop) },
    });
    expect(portal.status).toBe(201);
  });

  test("events from a connected account never touch billing", async () => {
    const shop = await createShop();
    const payload = JSON.stringify({
      id: "evt_connected",
      object: "event",
      type: "checkout.session.completed",
      account: "acct_123",
      data: {
        object: {
          id: "cs_connected",
          mode: "subscription",
          payment_status: "paid",
          client_reference_id: shop.tenant._id.toHexString(),
          customer: "cus_x",
          subscription: "sub_x",
        },
      },
    });
    const res = await app.request("/webhooks/stripe", {
      method: "POST",
      headers: {
        "Stripe-Signature":
          await requireStripe().webhooks.generateTestHeaderStringAsync({
            payload,
            secret: STRIPE_ENV.STRIPE_WEBHOOK_SECRET,
          }),
      },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect((await tenantDoc(shop.tenant._id))?.billing).toBeUndefined();
  });

  test("a webhook with a bad signature is refused and changes nothing", async () => {
    const shop = await createShop();
    const res = await webhook(
      "checkout.session.completed",
      { client_reference_id: shop.tenant._id.toHexString() },
      "whsec_wrong",
    );
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("BAD_SIGNATURE");
    expect((await tenantDoc(shop.tenant._id))?.billing).toBeUndefined();
  });
});
