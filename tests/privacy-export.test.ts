import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { appointments } from "../src/db/collections";
import { addBranch, api, createShop, createUser } from "./helpers";

const DAY = 864e5;

describe("customer downloads their data (ARCO access)", () => {
  test("gets their own records from this shop, without secrets", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const ana = await createUser(tenant, "customer", {
      name: "Ana López",
      phone: "+526641110000",
    });
    const other = await createUser(tenant, "customer", { name: "Luis" });
    const elsewhere = await addBranch(host, asOwner.token);
    await insertVisit(
      tenant._id,
      branchId,
      ana.user._id,
      "completed",
      -3,
      25_000,
    );
    await insertVisit(
      tenant._id,
      elsewhere,
      ana.user._id,
      "confirmed",
      5,
      30_000,
    );
    await insertVisit(
      tenant._id,
      branchId,
      other.user._id,
      "confirmed",
      6,
      99_000,
    );

    const res = await api("GET", "/v1/auth/me/export", {
      host,
      token: ana.token,
    });

    expect(res.status).toBe(200);
    expect(res.body.shop).toBe(tenant.name);
    expect(res.body.profile).toMatchObject({
      name: "Ana López",
      email: ana.user.email,
      phone: "+526641110000",
    });
    expect(res.body.appointments).toEqual([
      expect.objectContaining({ status: "completed", totalMinor: 25_000 }),
      expect.objectContaining({ status: "confirmed", totalMinor: 30_000 }),
    ]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain("stripeCustomerId");
    expect(text).not.toContain(ana.token);
    expect(text).not.toContain("99000");
  });

  test("staff can't download a customer's data", async () => {
    const { host, asOwner } = await createShop();
    const res = await api("GET", "/v1/auth/me/export", asOwner);
    expect(res.status).toBe(403);
  });
});

async function insertVisit(
  tenantId: ObjectId,
  branchId: string,
  customerId: ObjectId,
  status: "completed" | "confirmed",
  daysFromNow: number,
  totalMinor: number,
) {
  const startAt = new Date(Date.now() + daysFromNow * DAY);
  const endAt = new Date(startAt.getTime() + 45 * 60_000);
  await appointments.insertOne({
    _id: new ObjectId(),
    tenantId,
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
}
