import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/app";
import {
  ownerProject,
  platformStaff,
  referrals,
  subscriptionPayments,
  tenants,
} from "../src/db/collections";
import { platformLogin } from "../src/features/platform/auth";
import { api, createShop, createUser } from "./helpers";

// Published example CLABE, not a real account.
const CLABE = "002010077777777771";
const PASSWORD = "correct horse battery";
const PRICE = 30_000;

const projectId = new ObjectId();
let staffToken = "";

beforeAll(async () => {
  await ownerProject.insertOne({
    _id: projectId,
    email: "dueno@example.com",
    name: "Dueño del Proyecto",
    role: "owner",
    active: true,
    bankAccountKey: CLABE,
  });
  const email = `staff-${new ObjectId().toHexString()}@example.com`;
  const now = new Date();
  await platformStaff.insertOne({
    _id: new ObjectId(),
    email,
    name: "Staff",
    passwordHash: await Bun.password.hash(PASSWORD, {
      algorithm: "argon2id",
      memoryCost: 1024,
      timeCost: 1,
    }),
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  staffToken = (await platformLogin(email, PASSWORD)).token;
});

afterAll(async () => {
  await ownerProject.deleteOne({ _id: projectId });
});

type Shop = Awaited<ReturnType<typeof createShop>>;

async function staff(method: string, path: string, body?: unknown) {
  const res = await app.request(`/platform${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${staffToken}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const pay = (shop: Shop, body: Record<string, unknown> = {}) =>
  api("POST", "/v1/billing/payment", { ...shop.asOwner, body });

const confirm = (id: string, receivedMinor: number) =>
  staff("POST", `/subscriptions/${id}/confirm`, { receivedMinor });

/** Request and confirm one month, as the owner and then platform staff would. */
async function subscribe(shop: Shop, referralCode?: string) {
  const res = await pay(shop, referralCode ? { referralCode } : {});
  expect(res.status).toBe(201);
  const done = await confirm(String(res.body.id), Number(res.body.amountMinor));
  expect(done.status).toBe(200);
  return res.body;
}

const tenantOf = (shop: Shop) => tenants.findOne({ _id: shop.tenant._id });
type Summary = {
  subscribed: boolean;
  referral: { code: string | null };
  pending: unknown;
};
const summary = async (shop: Shop): Promise<Summary> =>
  (await api("GET", "/v1/billing", shop.asOwner)).body as unknown as Summary;

describe("billing by transfer", () => {
  test("only the owner sees billing; before paying there is no code to share", async () => {
    const shop = await createShop();
    const manager = await createUser(shop.tenant, "manager");
    expect(
      (
        await api("GET", "/v1/billing", {
          host: shop.host,
          token: manager.token,
        })
      ).status,
    ).toBe(403);
    const res = await api("GET", "/v1/billing", shop.asOwner);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      price: { amountMinor: PRICE, currency: "MXN", interval: "month" },
      pending: null,
      referral: { code: null, friendPercent: 20, rewardPercent: 10 },
    });
  });

  test("asking to pay copies the project's account; asking again returns the same payment", async () => {
    const shop = await createShop();
    const first = await pay(shop);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: "pending",
      amountMinor: PRICE,
      currency: "MXN",
      clabe: CLABE,
      holder: "Dueño del Proyecto",
    });
    expect((await pay(shop)).body.id).toBe(first.body.id);
    expect(
      await subscriptionPayments.countDocuments({ tenantId: shop.tenant._id }),
    ).toBe(1);
    expect((await summary(shop)).pending).toMatchObject({ id: first.body.id });
  });

  test("without a valid account in ownerProject nothing is offered", async () => {
    const shop = await createShop();
    await ownerProject.updateOne(
      { _id: projectId },
      { $set: { bankAccountKey: "018219378491738490" } },
    );
    try {
      const res = await pay(shop);
      expect(res.status).toBe(503);
      expect(res.body.error?.code).toBe("BILLING_DISABLED");
    } finally {
      await ownerProject.updateOne(
        { _id: projectId },
        { $set: { bankAccountKey: CLABE } },
      );
    }
  });

  test("platform staff confirming activates the plan for a month and hands out a referral code", async () => {
    const shop = await createShop({
      subscription: {
        plan: "trial",
        status: "trialing",
        limits: { branches: 1, barbers: 3 },
      },
    });
    const res = await pay(shop);
    const id = String(res.body.id);

    const wrong = await confirm(id, PRICE - 1);
    expect(wrong.status).toBe(422);
    expect((await tenantOf(shop))?.subscription.plan).toBe("trial");

    const ok = await confirm(id, PRICE);
    expect(ok.status).toBe(200);
    const tenant = await tenantOf(shop);
    expect(tenant?.subscription).toMatchObject({
      plan: "pro",
      status: "active",
      limits: { branches: 5, barbers: 30 },
    });
    const end = tenant?.subscription.currentPeriodEnd?.getTime() ?? 0;
    expect(end).toBeGreaterThan(Date.now() + 27 * 864e5);
    expect(end).toBeLessThan(Date.now() + 32 * 864e5);
    expect((await summary(shop)).subscribed).toBe(true);
    expect((await summary(shop)).referral).toMatchObject({
      code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{8}$/),
    });

    // Confirming twice changes nothing.
    const again = await confirm(id, PRICE);
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("INVALID_TRANSITION");
    expect(
      (await tenantOf(shop))?.subscription.currentPeriodEnd?.getTime(),
    ).toBe(end);
  });

  test("paying again before the period ends adds a month to what is left", async () => {
    const shop = await createShop();
    await subscribe(shop);
    const first = (await tenantOf(shop))?.subscription.currentPeriodEnd;
    await subscribe(shop);
    const second = (await tenantOf(shop))?.subscription.currentPeriodEnd;
    expect(
      second && first && second.getTime() - first.getTime(),
    ).toBeGreaterThan(27 * 864e5);
  });

  test("owners cannot confirm their own payment, and only platform staff can", async () => {
    const shop = await createShop();
    const res = await pay(shop);
    const id = String(res.body.id);
    const asOwner = await api("POST", `/platform/subscriptions/${id}/confirm`, {
      ...shop.asOwner,
      body: { receivedMinor: PRICE },
    });
    expect([401, 403, 404]).toContain(asOwner.status);
    const anonymous = await app.request(
      `/platform/subscriptions/${id}/confirm`,
      {
        method: "POST",
      },
    );
    expect(anonymous.status).toBe(401);
    expect(
      (await subscriptionPayments.findOne({ _id: new ObjectId(id) }))?.status,
    ).toBe("pending");
  });

  test("rejecting keeps the reason and lets the owner ask again; expired ones cannot be confirmed", async () => {
    const shop = await createShop();
    const first = await pay(shop);
    const rejected = await staff(
      "POST",
      `/subscriptions/${first.body.id}/reject`,
      { reason: "No llegó" },
    );
    expect(rejected.status).toBe(200);
    expect((await confirm(String(first.body.id), PRICE)).status).toBe(409);
    expect((await tenantOf(shop))?.subscription.plan).not.toBe("basic");

    const second = await pay(shop);
    expect(second.body.id).not.toBe(first.body.id);
    await subscriptionPayments.updateOne(
      { _id: new ObjectId(String(second.body.id)) },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await confirm(String(second.body.id), PRICE)).status).toBe(409);
    expect(
      (
        await subscriptionPayments.findOne({
          _id: new ObjectId(String(second.body.id)),
        })
      )?.status,
    ).toBe("expired");
    expect((await pay(shop)).status).toBe(201);
  });

  test("a lifetime barbershop never pays", async () => {
    const shop = await createShop({
      subscription: {
        plan: "lifetime",
        status: "active",
        limits: { branches: 50, barbers: 500 },
      },
    });
    const res = await pay(shop);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("LIFETIME_PLAN");
  });

  test("a lapsed period locks writes (402) but the owner can still reach billing", async () => {
    const shop = await createShop();
    await tenants.updateOne(
      { _id: shop.tenant._id },
      {
        $set: {
          "subscription.currentPeriodEnd": new Date(Date.now() - 10 * 864e5),
        },
      },
    );
    const locked = await api("PATCH", "/v1/tenant", {
      ...shop.asOwner,
      body: { name: "Nuevo nombre" },
    });
    expect(locked.status).toBe(402);
    expect((await api("GET", "/v1/billing", shop.asOwner)).status).toBe(200);
    expect((await pay(shop)).status).toBe(201);
  });
});

describe("referrals", () => {
  test("the friend gets 20% off the first month; the referrer gets 10% as credit that discounts their next one", async () => {
    const referrer = await createShop();
    await subscribe(referrer);
    const code = String((await summary(referrer)).referral.code);
    const friend = await createShop();

    const checked = await api("POST", "/v1/billing/referral-check", {
      ...friend.asOwner,
      body: { code },
    });
    expect(checked.body).toEqual({ code, discountPercent: 20 });

    const res = await pay(friend, { referralCode: code.toLowerCase() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amountMinor: 24_000,
      discountMinor: 6_000,
      listPriceMinor: PRICE,
    });
    expect((await confirm(String(res.body.id), 24_000)).status).toBe(200);

    const reward = await referrals.findOne({
      refereeTenantId: friend.tenant._id,
    });
    expect(reward).toMatchObject({ status: "rewarded", rewardMinor: 3_000 });
    expect((await tenantOf(referrer))?.billing?.creditMinor).toBe(3_000);
    expect(await summary(referrer)).toMatchObject({
      creditMinor: 3_000,
      referral: { referred: 1, rewarded: 1, earnedMinor: 3_000 },
    });
    expect(await summary(friend)).toMatchObject({
      referredBy: { discountPercent: 20 },
    });

    // The credit is spent on the referrer's next month, and only once it is confirmed.
    const next = await pay(referrer);
    expect(next.body).toMatchObject({
      amountMinor: 27_000,
      creditAppliedMinor: 3_000,
    });
    expect((await tenantOf(referrer))?.billing?.creditMinor).toBe(3_000);
    expect((await confirm(String(next.body.id), 27_000)).status).toBe(200);
    expect((await tenantOf(referrer))?.billing?.creditMinor).toBe(0);
  });

  test("credit that covers the whole month settles it without a transfer", async () => {
    const shop = await createShop();
    await tenants.updateOne(
      { _id: shop.tenant._id },
      { $set: { "billing.creditMinor": PRICE } },
    );
    const res = await pay(shop);
    expect(res.body).toMatchObject({ amountMinor: 0, status: "paid" });
    const tenant = await tenantOf(shop);
    expect(tenant?.subscription.plan).toBe("pro");
    expect(tenant?.billing?.creditMinor).toBe(0);
  });

  test("codes are refused for yourself, the same owner, after the first month, or when unknown", async () => {
    const referrer = await createShop();
    await subscribe(referrer);
    const code = String((await summary(referrer)).referral.code);
    const check = (shop: Shop, value: string) =>
      api("POST", "/v1/billing/referral-check", {
        ...shop.asOwner,
        body: { code: value },
      });

    expect((await check(referrer, code)).body.error?.code).toBe(
      "REFERRAL_SELF",
    );
    expect((await check(await createShop(), "AAAAAAAA")).body.error?.code).toBe(
      "REFERRAL_NOT_FOUND",
    );

    const veteran = await createShop();
    await subscribe(veteran);
    const late = await check(veteran, code);
    expect(late.status).toBe(409);
    expect(late.body.error?.code).toBe("REFERRAL_NOT_FIRST");
    expect((await pay(veteran, { referralCode: code })).status).toBe(409);
  });
});

describe("the staff queue", () => {
  test("lists transfers by status with the barbershop's name", async () => {
    const shop = await createShop();
    const res = await pay(shop);
    const listed = await staff("GET", "/subscriptions?status=pending");
    expect(listed.status).toBe(200);
    const rows = listed.body as { id: string; tenantSlug: string }[];
    expect(rows.find((r) => r.id === res.body.id)?.tenantSlug).toBe(
      shop.tenant.slug,
    );
    expect((await app.request("/platform/subscriptions")).status).toBe(401);
  });
});
