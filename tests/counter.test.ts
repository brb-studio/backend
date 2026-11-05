import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  appointments,
  productOrders,
  type TenantDoc,
} from "../src/db/collections";
import {
  addBranch,
  api,
  bookingShop,
  createShop,
  createUser,
  dayIn,
  type Who,
} from "./helpers";

const HOUR = 3_600_000;

async function visit(
  tenant: TenantDoc,
  branchId: string,
  customerId: ObjectId,
  over: Partial<AppointmentDoc> = {},
) {
  const startAt = over.startAt ?? new Date(Date.now() - 60_000);
  const endAt = new Date(startAt.getTime() + 45 * 60_000);
  const doc: AppointmentDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    branchId: new ObjectId(branchId),
    barberId: new ObjectId(),
    customerId,
    status: "confirmed",
    startAt,
    endAt,
    blockedUntil: endAt,
    timeZone: ZONE,
    items: [
      {
        kind: "service",
        serviceId: new ObjectId(),
        name: { es: "Corte" },
        durationMin: 45,
        priceMinor: 30_000,
      },
    ],
    currency: "MXN",
    subtotalMinor: 30_000,
    discountMinor: 0,
    totalMinor: 30_000,
    source: "staff",
    createdAt: startAt,
    updatedAt: startAt,
    ...over,
  };
  await appointments.insertOne(doc);
  return doc._id.toHexString();
}

const complete = (who: Who, id: string, paidWith?: string) =>
  api("PATCH", `/v1/appointments/${id}`, {
    ...who,
    body: { status: "completed", ...(paidWith && { paidWith }) },
  });

const ZONE = "America/Tijuana";
const today = () => dayIn(ZONE, 0);

describe("paying at the counter", () => {
  test("completing asks how the rest was paid and records exactly what was due", async () => {
    const { tenant, branchId, asOwner } = await createShop();
    const ana = await createUser(tenant, "customer");
    const plain = await visit(tenant, branchId, ana.user._id);
    const deposit = await visit(tenant, branchId, ana.user._id, {
      payment: { provider: "stripe", status: "paid", amountMinor: 10_000 },
    });
    const prepaid = await visit(tenant, branchId, ana.user._id, {
      payment: { provider: "stripe", status: "paid", amountMinor: 30_000 },
    });

    const missing = await complete(asOwner, plain);
    expect(missing.status).toBe(422);
    expect(missing.body.error?.code).toBe("PAYMENT_METHOD_REQUIRED");
    expect(
      (
        await api("PATCH", `/v1/appointments/${plain}`, {
          ...asOwner,
          body: { status: "no_show", paidWith: "cash" },
        })
      ).status,
    ).toBe(422);

    expect((await complete(asOwner, plain, "cash")).body).toMatchObject({
      status: "completed",
      counter: { method: "cash", amountMinor: 30_000 },
    });
    expect((await complete(asOwner, deposit, "card")).body).toMatchObject({
      counter: { method: "card", amountMinor: 20_000 },
    });
    const done = await complete(asOwner, prepaid);
    expect(done.status).toBe(200);
    expect(done.body.counter).toBeUndefined();
  });

  test("the day's cash report adds up methods, people and pickups; managers see their branch", async () => {
    const { tenant, host, owner, branchId, asOwner } = await createShop({
      products: { enabled: true },
    });
    const north = await addBranch(host, owner.token);
    const manager = await createUser(tenant, "manager", {
      name: "Lucía",
      branchId: new ObjectId(branchId),
    });
    const ana = await createUser(tenant, "customer", { name: "Ana" });
    const asManager = { host, token: manager.token };

    await complete(
      asManager,
      await visit(tenant, branchId, ana.user._id),
      "cash",
    );
    await complete(
      asOwner,
      await visit(tenant, branchId, ana.user._id, {
        payment: { provider: "stripe", status: "paid", amountMinor: 10_000 },
      }),
      "card",
    );
    await complete(asOwner, await visit(tenant, north, ana.user._id), "cash");
    await visit(tenant, branchId, ana.user._id, { status: "completed" });
    const now = new Date();
    const orderId = new ObjectId();
    await productOrders.insertOne({
      _id: orderId,
      tenantId: tenant._id,
      branchId: new ObjectId(branchId),
      customerId: ana.user._id,
      status: "reserved",
      items: [
        {
          productId: new ObjectId(),
          name: { es: "Cera" },
          priceMinor: 18_000,
          quantity: 1,
        },
      ],
      currency: "MXN",
      totalMinor: 18_000,
      expiresAt: new Date(now.getTime() + 7 * 24 * HOUR),
      createdAt: now,
      updatedAt: now,
    });
    expect(
      (
        await api("POST", `/v1/product-orders/${orderId}/deliver`, {
          ...asManager,
          body: { method: "spei" },
        })
      ).status,
    ).toBe(200);

    const all = await api("GET", `/v1/cash?date=${today()}`, asOwner);
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      currency: "MXN",
      totals: { cashMinor: 60_000, cardMinor: 20_000, transferMinor: 18_000 },
      unrecorded: 1,
      inMinor: 98_000,
      outMinor: 0,
      netMinor: 98_000,
      pending: { count: 1, amountMinor: 30_000 },
    });
    expect(all.body.entries).toHaveLength(4);
    expect(all.body.people).toEqual(
      expect.arrayContaining([
        {
          id: manager.user._id.toHexString(),
          name: "Lucía",
          cashMinor: 30_000,
          cardMinor: 0,
          transferMinor: 18_000,
        },
      ]),
    );
    expect(all.body.movements).toHaveLength(4);

    const mine = await api("GET", `/v1/cash?date=${today()}`, asManager);
    expect(mine.body.totals).toEqual({
      cashMinor: 30_000,
      cardMinor: 20_000,
      transferMinor: 18_000,
    });
    expect(
      (
        await api(
          "GET",
          `/v1/cash?date=${today()}&branchId=${north}`,
          asManager,
        )
      ).status,
    ).toBe(404);
    const barber = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    expect(
      (
        await api("GET", `/v1/cash?date=${today()}`, {
          host,
          token: barber.token,
        })
      ).status,
    ).toBe(403);

    const summary = await api(
      "GET",
      `/v1/earnings/summary?from=${today()}&to=${today()}`,
      asOwner,
    );
    expect(summary.body.collected).toEqual({
      onlineMinor: 10_000,
      cashMinor: 60_000,
      cardMinor: 20_000,
      transferMinor: 18_000,
      unrecordedMinor: 30_000,
    });
  });
});

describe("loyalty", () => {
  test("every Nth visit gets the reward and the customer sees their progress", async () => {
    const shop = await bookingShop();
    const ana = await createUser(shop.tenant, "customer");
    const asAna = { host: shop.host, token: ana.token };
    const created = await api("POST", "/v1/promotions", {
      ...shop.asOwner,
      body: {
        name: { es: "Tu 3.er corte gratis" },
        type: "percent",
        value: 100,
        everyVisits: 3,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.everyVisits).toBe(3);
    expect(
      (
        await api("POST", "/v1/promotions", {
          ...shop.asOwner,
          body: {
            name: { es: "Mal" },
            type: "percent",
            value: 10,
            everyVisits: 3,
            firstVisitOnly: true,
          },
        })
      ).status,
    ).toBe(422);

    const quote = async () =>
      (
        await api("POST", "/v1/public/quote", {
          ...asAna,
          body: { branch: "centro", service: "corte" },
        })
      ).body;
    const progress = async () =>
      (await api("GET", "/v1/me/loyalty", asAna)).body as unknown;
    expect(await quote()).toMatchObject({ discountMinor: 0 });

    await visit(shop.tenant, shop.branchId, ana.user._id, {
      status: "completed",
    });
    await visit(shop.tenant, shop.branchId, ana.user._id, {
      startAt: new Date(Date.now() + 48 * HOUR),
    });
    expect(await quote()).toMatchObject({
      discountMinor: 30_000,
      totalMinor: 0,
    });
    expect(await progress()).toEqual([
      expect.objectContaining({ everyVisits: 3, visits: 2, value: 100 }),
    ]);

    const off = await api("PATCH", `/v1/promotions/${created.body.id}`, {
      ...shop.asOwner,
      body: { everyVisits: null },
    });
    expect(off.body.everyVisits).toBeUndefined();
    expect(await progress()).toEqual([]);
  });
});
