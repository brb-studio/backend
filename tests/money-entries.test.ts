import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  appointments,
  ledgerEntries,
  payments,
  type TenantDoc,
} from "../src/db/collections";
import { api, createShop, createUser, dayIn } from "./helpers";

const ZONE = "America/Tijuana";
const today = () => dayIn(ZONE, 0);

async function paidBySpei(
  tenant: TenantDoc,
  branchId: string,
  customerId: ObjectId,
) {
  const now = new Date();
  const appointmentId = new ObjectId();
  const paymentId = new ObjectId();
  const doc: AppointmentDoc = {
    _id: appointmentId,
    tenantId: tenant._id,
    branchId: new ObjectId(branchId),
    barberId: new ObjectId(),
    customerId,
    status: "confirmed",
    startAt: new Date(now.getTime() + 864e5),
    endAt: new Date(now.getTime() + 864e5 + 45 * 60_000),
    blockedUntil: new Date(now.getTime() + 864e5 + 45 * 60_000),
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
    payment: {
      provider: "spei",
      paymentId,
      method: "spei",
      status: "paid",
      amountMinor: 30_000,
      paidAt: now,
    },
    source: "online",
    createdAt: now,
    updatedAt: now,
  };
  await appointments.insertOne(doc);
  await payments.insertOne({
    _id: paymentId,
    tenantId: tenant._id,
    appointmentId,
    method: "spei",
    status: "paid",
    amountMinor: 30_000,
    currency: "MXN",
    bank: { clabe: "002010077777777771", holder: "Barbería" },
    createdAt: now,
    expiresAt: new Date(now.getTime() + 864e5),
    resolvedAt: now,
    history: [
      { status: "pending", at: now },
      { status: "paid", at: now },
    ],
  });
  return { appointmentId: appointmentId.toHexString(), paymentId };
}

describe("expenses, adjustments and reversals", () => {
  test("owners record expenses and adjustments; a note is required to adjust; managers can't write", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const post = (body: Record<string, unknown>, who = asOwner) =>
      api("POST", "/v1/money/entries", { ...who, body });

    const towels = await post({
      type: "expense",
      amountMinor: 45_000,
      method: "cash",
      branchId,
      concept: "Toallas",
    });
    expect(towels.status).toBe(201);
    expect(towels.body).toMatchObject({ direction: "out", type: "expense" });

    expect(
      (
        await post({
          type: "adjustment",
          direction: "in",
          amountMinor: 1_000,
          method: "cash",
          branchId,
          concept: "Sobrante",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await post({
          type: "expense",
          direction: "in",
          amountMinor: 1_000,
          method: "cash",
          branchId,
          concept: "Mal",
        })
      ).status,
    ).toBe(422);
    const extra = await post({
      type: "adjustment",
      direction: "in",
      amountMinor: 2_000,
      method: "cash",
      branchId,
      concept: "Sobrante de caja",
      note: "Contado al cierre",
    });
    expect(extra.status).toBe(201);

    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    expect(
      (
        await post(
          {
            type: "expense",
            amountMinor: 1_000,
            method: "cash",
            branchId,
            concept: "Café",
          },
          { host, token: manager.token },
        )
      ).status,
    ).toBe(403);

    const cash = await api("GET", `/v1/cash?date=${today()}`, asOwner);
    expect(cash.body).toMatchObject({
      inMinor: 2_000,
      outMinor: 45_000,
      netMinor: -43_000,
    });
  });

  test("a reversal undoes an entry once, in the opposite direction, and can't itself be reversed", async () => {
    const { branchId, asOwner } = await createShop();
    const post = (body: Record<string, unknown>) =>
      api("POST", "/v1/money/entries", { ...asOwner, body });
    const wrong = await post({
      type: "expense",
      amountMinor: 45_000,
      method: "card",
      branchId,
      concept: "Toallas",
    });
    const id = String(wrong.body.id);
    const undo = await post({
      type: "adjustment",
      reverses: id,
      note: "Se capturó dos veces",
    });
    expect(undo.status).toBe(201);
    expect(undo.body).toMatchObject({
      direction: "in",
      type: "adjustment",
      amountMinor: 45_000,
      method: "card",
      reverses: id,
    });
    const again = await post({
      type: "adjustment",
      reverses: id,
      note: "otra",
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("ALREADY_REVERSED");
    const chain = await post({
      type: "adjustment",
      reverses: String(undo.body.id),
      note: "x",
    });
    expect(chain.body.error?.code).toBe("NOT_REVERSIBLE");

    const cash = await api("GET", `/v1/cash?date=${today()}`, asOwner);
    expect(cash.body.netMinor).toBe(0);
    expect(cash.body.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id, reversed: true }),
        expect.objectContaining({ reverses: id, note: "Se capturó dos veces" }),
      ]),
    );
  });
});

describe("returning a SPEI transfer", () => {
  test("a partial then a full return leave refund entries and a refunded payment", async () => {
    const { tenant, branchId, asOwner } = await createShop();
    const ana = await createUser(tenant, "customer");
    const { appointmentId, paymentId } = await paidBySpei(
      tenant,
      branchId,
      ana.user._id,
    );
    const refund = (body: Record<string, unknown>) =>
      api("POST", `/v1/payments/appointments/${appointmentId}/refund`, {
        ...asOwner,
        body,
      });

    expect((await refund({ amountMinor: 40_000 })).body.error?.code).toBe(
      "REFUND_TOO_LARGE",
    );
    const part = await refund({ amountMinor: 10_000, reference: "DEV001" });
    expect(part.status).toBe(200);
    expect(part.body).toMatchObject({ status: "paid", refundedMinor: 10_000 });
    const rest = await refund({});
    expect(rest.body).toMatchObject({
      status: "refunded",
      refundedMinor: 30_000,
    });
    expect((await refund({})).body.error?.code).toBe("NOT_REFUNDABLE");

    expect((await payments.findOne({ _id: paymentId }))?.status).toBe(
      "refunded",
    );
    expect(
      (await appointments.findOne({ _id: new ObjectId(appointmentId) }))
        ?.payment,
    ).toMatchObject({ status: "refunded", refundedMinor: 30_000 });
    const entries = await ledgerEntries
      .find({ paymentId, type: "refund" })
      .sort({ amountMinor: 1 })
      .toArray();
    expect(
      entries.map((e) => [e.direction, e.channel, e.amountMinor, e.reference]),
    ).toEqual([
      ["out", "spei", 10_000, "DEV001"],
      ["out", "spei", 20_000, undefined],
    ]);
  });
});
