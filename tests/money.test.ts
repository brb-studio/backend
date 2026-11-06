import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  appointments,
  type LedgerEntryDoc,
  ledgerEntries,
  productOrders,
  type TenantDoc,
} from "../src/db/collections";
import { migrateLedger } from "../src/db/ledger-backfill";
import {
  addBarber,
  addBranch,
  api,
  createShop,
  createUser,
  dayIn,
  type Who,
} from "./helpers";

const ZONE = "America/Tijuana";
const today = () => dayIn(ZONE, 0);

async function visit(
  tenant: TenantDoc,
  branchId: string,
  barberId: string,
  customerId: ObjectId,
  over: Partial<AppointmentDoc> = {},
) {
  const startAt = new Date(Date.now() - 60_000);
  const endAt = new Date(startAt.getTime() + 45 * 60_000);
  const doc: AppointmentDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    branchId: new ObjectId(branchId),
    barberId: new ObjectId(barberId),
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

const complete = (who: Who, id: string, paidWith: string) =>
  api("PATCH", `/v1/appointments/${id}`, {
    ...who,
    body: { status: "completed", paidWith },
  });

async function reservedOrder(
  tenant: TenantDoc,
  branchId: string,
  customerId: ObjectId,
) {
  const now = new Date();
  const _id = new ObjectId();
  await productOrders.insertOne({
    _id,
    tenantId: tenant._id,
    branchId: new ObjectId(branchId),
    customerId,
    status: "reserved",
    items: [
      {
        productId: new ObjectId(),
        name: { es: "Cera" },
        priceMinor: 9_000,
        quantity: 2,
      },
    ],
    currency: "MXN",
    totalMinor: 18_000,
    expiresAt: new Date(now.getTime() + 864e5),
    createdAt: now,
    updatedAt: now,
  });
  return _id.toHexString();
}

describe("money ledger", () => {
  test("counter payments, product pickups and payouts are written once and read back", async () => {
    const { tenant, host, owner, branchId, asOwner } = await createShop({
      products: { enabled: true },
    });
    const barberId = await addBarber(host, owner.token, branchId, {
      name: "Carlos",
    });
    const ana = await createUser(tenant, "customer", { name: "Ana" });

    const cut = await visit(tenant, branchId, barberId, ana.user._id);
    expect((await complete(asOwner, cut, "cash")).status).toBe(200);
    const order = await reservedOrder(tenant, branchId, ana.user._id);
    expect(
      (
        await api("POST", `/v1/product-orders/${order}/deliver`, {
          ...asOwner,
          body: { method: "spei" },
        })
      ).status,
    ).toBe(200);
    await api("PATCH", `/v1/earnings/barbers/${barberId}`, {
      ...asOwner,
      body: { commissionBps: 5_000 },
    });
    expect(
      (
        await api("POST", "/v1/earnings/payouts", {
          ...asOwner,
          body: { barberId, appointmentIds: [cut], reference: "REC-1" },
        })
      ).status,
    ).toBe(201);

    const summary = await api(
      "GET",
      `/v1/money/summary?from=${today()}&to=${today()}`,
      asOwner,
    );
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      currency: "MXN",
      inMinor: 48_000,
      outMinor: 15_000,
      netMinor: 33_000,
      servicesMinor: 30_000,
      productsMinor: 18_000,
      byMethod: {
        cash: { inMinor: 30_000, outMinor: 0 },
        transfer: { inMinor: 18_000, outMinor: 0 },
      },
      series: [{ period: today(), inMinor: 48_000, outMinor: 15_000 }],
      previous: { inMinor: 0, outMinor: 0 },
    });

    const cash = await api("GET", `/v1/cash?date=${today()}`, asOwner);
    expect(cash.body).toMatchObject({
      inMinor: 48_000,
      outMinor: 15_000,
      netMinor: 33_000,
    });
    expect(cash.body.entries).toHaveLength(3);

    const list = await api(
      "GET",
      `/v1/money/movements?from=${today()}&to=${today()}`,
      asOwner,
    );
    expect(list.body.total).toBe(3);
    expect(list.body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "service_payment",
          direction: "in",
          timeZone: "America/Tijuana",
          concept: "Corte",
          customer: "Ana",
          recordedBy: "owner",
          method: "cash",
          amountMinor: 30_000,
        }),
        expect.objectContaining({
          type: "product_sale",
          concept: "Cera ×2",
          method: "transfer",
          amountMinor: 18_000,
        }),
        expect.objectContaining({
          type: "payout",
          direction: "out",
          concept: "Carlos",
          reference: "REC-1",
          amountMinor: 15_000,
        }),
      ]),
    );
    const outs = await api(
      "GET",
      `/v1/money/movements?from=${today()}&to=${today()}&direction=out`,
      asOwner,
    );
    expect(outs.body.total).toBe(1);

    expect(await migrateLedger(true)).toMatchObject({
      inserted: expect.any(Number),
    });
    expect(await ledgerEntries.countDocuments({ tenantId: tenant._id })).toBe(
      3,
    );
  });

  test("managers only see their branch; barbers see nothing", async () => {
    const { tenant, host, owner, branchId, asOwner } = await createShop();
    const north = await addBranch(host, owner.token);
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const asManager = { host, token: manager.token };
    const ana = await createUser(tenant, "customer");
    const barberId = await addBarber(host, owner.token, branchId);
    await complete(
      asOwner,
      await visit(tenant, branchId, barberId, ana.user._id),
      "card",
    );
    await complete(
      asOwner,
      await visit(tenant, north, barberId, ana.user._id),
      "cash",
    );

    const q = `from=${today()}&to=${today()}`;
    expect(
      (await api("GET", `/v1/money/summary?${q}`, asOwner)).body.inMinor,
    ).toBe(60_000);
    expect(
      (await api("GET", `/v1/money/summary?${q}`, asManager)).body.inMinor,
    ).toBe(30_000);
    expect(
      (await api("GET", `/v1/money/summary?${q}&branchId=${north}`, asManager))
        .status,
    ).toBe(404);
    const barber = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    expect(
      (
        await api("GET", `/v1/money/summary?${q}`, {
          host,
          token: barber.token,
        })
      ).status,
    ).toBe(403);
  });

  test("the daily cash of each day adds up to the earnings of the range", async () => {
    const { tenant, host, owner, branchId, asOwner } = await createShop();
    const north = await addBranch(host, owner.token);
    const days = [dayIn(ZONE, -3), dayIn(ZONE, -2), dayIn(ZONE, -1)];
    const entries: LedgerEntryDoc[] = days.flatMap((day, i) =>
      [branchId, north].flatMap((branch, j) => [
        {
          _id: new ObjectId(),
          tenantId: tenant._id,
          branchId: new ObjectId(branch),
          source: `test:${day}:${branch}:in`,
          at: new Date(`${day}T20:00:00Z`),
          localDate: day,
          direction: "in" as const,
          type: "service_payment" as const,
          method: "cash" as const,
          amountMinor: 10_000 * (i + 1) + j,
          currency: "MXN",
          concept: "Corte",
          createdAt: new Date(),
        },
        {
          _id: new ObjectId(),
          tenantId: tenant._id,
          branchId: new ObjectId(branch),
          source: `test:${day}:${branch}:out`,
          at: new Date(`${day}T22:00:00Z`),
          localDate: day,
          direction: "out" as const,
          type: "expense" as const,
          amountMinor: 1_000 * (i + 1),
          currency: "MXN",
          concept: "Toallas",
          createdAt: new Date(),
        },
      ]),
    );
    await ledgerEntries.insertMany(entries);

    const summary = async (from: string, to: string) =>
      (await api("GET", `/v1/money/summary?from=${from}&to=${to}`, asOwner))
        .body as {
        inMinor: number;
        outMinor: number;
        netMinor: number;
      };
    const range = await summary(days[0] ?? "", days[2] ?? "");
    const daily = { inMinor: 0, outMinor: 0, netMinor: 0 };
    for (const day of days) {
      const one = await summary(day, day);
      daily.inMinor += one.inMinor;
      daily.outMinor += one.outMinor;
      daily.netMinor += one.netMinor;
    }
    expect(daily).toEqual({
      inMinor: range.inMinor,
      outMinor: range.outMinor,
      netMinor: range.netMinor,
    });
    expect(range.inMinor).toBe(
      entries
        .filter((e) => e.direction === "in")
        .reduce((s, e) => s + e.amountMinor, 0),
    );
  });

  test("the migration rebuilds old money once, however many times it runs", async () => {
    const { tenant, host, owner, branchId } = await createShop();
    const barberId = await addBarber(host, owner.token, branchId);
    const ana = await createUser(tenant, "customer");
    const old = await visit(tenant, branchId, barberId, ana.user._id, {
      status: "completed",
      counter: {
        method: "cash",
        amountMinor: 30_000,
        receivedBy: owner.user._id,
        at: new Date(),
      },
    });
    await migrateLedger(true);
    const second = await migrateLedger(true);
    expect(second.inserted).toBe(0);
    expect(
      await ledgerEntries.countDocuments({ appointmentId: new ObjectId(old) }),
    ).toBe(1);
  });
});
