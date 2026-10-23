import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { addBranch, api, create, createShop, createUser } from "./helpers";

describe("an owner who also cuts", () => {
  test("creates their own bookable profile in one step, linked to their account", async () => {
    const { tenant, host, owner, branchId, asOwner } = await createShop();
    const corte = await create(asOwner, "/v1/services", {
      slug: "corte",
      name: { es: "Corte" },
      durationMin: 45,
      priceMinor: 25_000,
    });
    await create(asOwner, "/v1/barbers", {
      branchId,
      slug: "owner",
      name: "Otro",
    });

    const mine = await api("POST", "/v1/barbers/me", { ...asOwner, body: {} });
    expect(mine.status).toBe(201);
    expect(mine.body).toMatchObject({
      name: "owner",
      slug: "owner-2",
      branchId,
      userId: owner.user._id.toHexString(),
      serviceIds: [corte],
    });
    expect(
      (await api("GET", "/v1/appointments/my-day", asOwner)).body.barber,
    ).toMatchObject({ name: "owner" });
    const publicBarbers = await api("GET", "/v1/public/barbers?service=corte", {
      host,
    });
    expect(JSON.stringify(publicBarbers.body)).toContain("owner-2");

    const again = await api("POST", "/v1/barbers/me", { ...asOwner, body: {} });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("USER_LINKED");

    for (const role of ["barber", "manager"] as const) {
      const { token } = await createUser(tenant, role, {
        branchId: new ObjectId(branchId),
      });
      expect(
        (await api("POST", "/v1/barbers/me", { host, token, body: {} })).status,
      ).toBe(403);
    }
  });

  test("with several branches the owner says where they work", async () => {
    const { host, owner, asOwner } = await createShop();
    const north = await addBranch(host, owner.token);
    const unsure = await api("POST", "/v1/barbers/me", {
      ...asOwner,
      body: {},
    });
    expect(unsure.status).toBe(422);
    const there = await api("POST", "/v1/barbers/me", {
      ...asOwner,
      body: { branchId: north },
    });
    expect(there.status).toBe(201);
    expect(there.body.branchId).toBe(north);
  });
});
