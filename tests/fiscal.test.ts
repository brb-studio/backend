import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  appointments,
  invoiceRequests,
  type TenantDoc,
} from "../src/db/collections";
import { api, createShop, createUser } from "./helpers";

const DAY = 864e5;

const invoicing = {
  enabled: true,
  rfc: "XAXX010101000",
  legalName: "Barbería Demo SA de CV",
  taxRegime: "601",
  postalCode: "64000",
};
const receiver = {
  rfc: "xaxx010101000",
  legalName: "Ana López",
  taxRegime: "616",
  postalCode: "64000",
  cfdiUse: "G03",
};

async function visit(
  tenant: TenantDoc,
  branchId: string,
  customerId: ObjectId,
  status: "completed" | "confirmed",
  totalMinor: number,
) {
  const startAt = new Date(Date.now() - DAY);
  const endAt = new Date(startAt.getTime() + 45 * 60_000);
  const _id = new ObjectId();
  await appointments.insertOne({
    _id,
    tenantId: tenant._id,
    branchId: new ObjectId(branchId),
    barberId: new ObjectId(),
    customerId,
    status,
    startAt,
    endAt,
    blockedUntil: endAt,
    timeZone: "UTC",
    items: [
      {
        kind: "service",
        serviceId: new ObjectId(),
        name: { es: "Corte" },
        durationMin: 45,
        priceMinor: totalMinor,
      },
    ],
    currency: "MXN",
    subtotalMinor: totalMinor,
    discountMinor: 0,
    totalMinor,
    source: "staff",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return _id;
}

describe("optional IVA and invoices per barbershop", () => {
  test("a shop without invoicing refuses requests; turning it on lets customers ask", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const ana = await createUser(tenant, "customer");
    const me = { host, token: ana.token };
    const done = await visit(
      tenant,
      branchId,
      ana.user._id,
      "completed",
      25_000,
    );

    const off = await api(
      "POST",
      `/v1/me/appointments/${done.toHexString()}/invoice`,
      {
        ...me,
        body: receiver,
      },
    );
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({ error: { code: "INVOICING_DISABLED" } });

    const on = await api("PATCH", "/v1/tenant", {
      ...asOwner,
      body: { invoicing, iva: { enabled: true } },
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ invoicing, iva: { enabled: true } });

    const asked = await api(
      "POST",
      `/v1/me/appointments/${done.toHexString()}/invoice`,
      {
        ...me,
        body: receiver,
      },
    );
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({
      status: "requested",
      amountMinor: 25_000,
      currency: "MXN",
      receiver: { ...receiver, rfc: "XAXX010101000" },
    });

    const again = await api(
      "POST",
      `/v1/me/appointments/${done.toHexString()}/invoice`,
      {
        ...me,
        body: receiver,
      },
    );
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      error: { code: "INVOICE_ALREADY_REQUESTED" },
    });
  });

  test("only completed visits of their own can be invoiced", async () => {
    const { tenant, host, branchId } = await createShop({
      invoicing,
    } as Partial<TenantDoc>);
    const ana = await createUser(tenant, "customer");
    const luis = await createUser(tenant, "customer");
    const upcoming = await visit(
      tenant,
      branchId,
      ana.user._id,
      "confirmed",
      30_000,
    );
    const theirs = await visit(
      tenant,
      branchId,
      luis.user._id,
      "completed",
      30_000,
    );
    const me = { host, token: ana.token };

    const notDone = await api(
      "POST",
      `/v1/me/appointments/${upcoming.toHexString()}/invoice`,
      {
        ...me,
        body: receiver,
      },
    );
    expect(notDone.body).toMatchObject({ error: { code: "NOT_COMPLETED" } });

    const notMine = await api(
      "POST",
      `/v1/me/appointments/${theirs.toHexString()}/invoice`,
      {
        ...me,
        body: receiver,
      },
    );
    expect(notMine.status).toBe(404);

    const badRfc = await api(
      "POST",
      `/v1/me/appointments/${theirs.toHexString()}/invoice`,
      {
        ...me,
        body: { ...receiver, rfc: "NO-ES-RFC" },
      },
    );
    expect(badRfc.status).toBe(422);
    expect(await invoiceRequests.countDocuments({ tenantId: tenant._id })).toBe(
      0,
    );
  });

  test("the shop sees the queue, records the CFDI UUID and can't close an invoice twice", async () => {
    const { tenant, host, branchId, asOwner } = await createShop({
      invoicing,
    } as Partial<TenantDoc>);
    const ana = await createUser(tenant, "customer");
    const done = await visit(
      tenant,
      branchId,
      ana.user._id,
      "completed",
      25_000,
    );
    const asked = await api(
      "POST",
      `/v1/me/appointments/${done.toHexString()}/invoice`,
      {
        host,
        token: ana.token,
        body: receiver,
      },
    );
    const id = String(asked.body.id);

    const queue = await api("GET", "/v1/invoices", asOwner);
    expect(queue.body as unknown).toEqual([
      expect.objectContaining({ id, status: "requested" }),
    ]);
    expect(
      (await api("GET", "/v1/invoices", { host, token: ana.token })).status,
    ).toBe(403);

    const noUuid = await api("PATCH", `/v1/invoices/${id}`, {
      ...asOwner,
      body: { status: "issued" },
    });
    expect(noUuid.status).toBe(422);

    const uuid = "6f1f3f0e-2b7a-4c1d-9e8a-1234567890ab";
    const issued = await api("PATCH", `/v1/invoices/${id}`, {
      ...asOwner,
      body: { status: "issued", cfdiUuid: uuid },
    });
    expect(issued.status).toBe(200);
    expect(issued.body).toMatchObject({ status: "issued", cfdiUuid: uuid });

    const twice = await api("PATCH", `/v1/invoices/${id}`, {
      ...asOwner,
      body: { status: "cancelled" },
    });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ error: { code: "INVOICE_CLOSED" } });

    const mine = await api("GET", "/v1/me/invoices", {
      host,
      token: ana.token,
    });
    expect(mine.body as unknown).toEqual([
      expect.objectContaining({ id, status: "issued" }),
    ]);
  });

  test("customers see the IVA inside each total once it is on", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const ana = await createUser(tenant, "customer");
    await visit(tenant, branchId, ana.user._id, "completed", 11_600);
    const me = { host, token: ana.token };

    const before = await api(
      "GET",
      "/v1/me/appointments/history?page=1&pageSize=5",
      me,
    );
    expect((before.body.items as object[])[0]).not.toHaveProperty("iva");

    await api("PATCH", "/v1/tenant", {
      ...asOwner,
      body: { iva: { enabled: true } },
    });
    const after = await api(
      "GET",
      "/v1/me/appointments/history?page=1&pageSize=5",
      me,
    );
    expect((after.body.items as object[])[0]).toMatchObject({
      totalMinor: 11_600,
      iva: { baseMinor: 10_000, ivaMinor: 1_600 },
    });
  });
});
