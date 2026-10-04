import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { promotions } from "../src/db/collections";
import {
  api,
  bookingShop,
  create,
  createUser,
  dayIn,
  guestBooking,
  instantIn,
  nextPhone,
  type Shop,
} from "./helpers";

const at = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);
const book = (shop: Shop, body: Record<string, unknown>) =>
  api("POST", "/v1/public/appointments", { host: shop.host, body });
const quote = (shop: Shop, body: Record<string, unknown>) =>
  api("POST", "/v1/public/quote", {
    host: shop.host,
    body: { branch: "centro", ...body },
  });
const promo = (shop: Shop, body: Record<string, unknown>) =>
  create(shop.asOwner, "/v1/promotions", { name: { es: "Promo" }, ...body });

describe("promotions admin", () => {
  test("validation, references and permissions", async () => {
    const shop = await bookingShop();
    const other = await bookingShop();
    for (const body of [
      { name: { es: "X" }, type: "percent", value: 101 },
      { name: { es: "X" }, type: "fixed", value: 0 },
      {
        name: { es: "X" },
        type: "fixed",
        value: 100,
        startsAt: "2026-12-02T00:00:00Z",
        endsAt: "2026-12-01T00:00:00Z",
      },
      {
        name: { es: "X" },
        type: "fixed",
        value: 100,
        serviceIds: [other.services.corte],
      },
      { name: { es: "X" }, type: "fixed", value: 100, code: "a b" },
    ]) {
      expect(
        (await api("POST", "/v1/promotions", { ...shop.asOwner, body })).status,
      ).toBe(422);
    }
    await promo(shop, { type: "fixed", value: 100, code: "verano" });
    const dup = await api("POST", "/v1/promotions", {
      ...shop.asOwner,
      body: { name: { es: "X" }, type: "fixed", value: 100, code: "VERANO" },
    });
    expect(dup.status).toBe(409);
    const manager = await createUser(shop.tenant, "manager", {
      branchId: new ObjectId(shop.branchId),
    });
    expect(
      (
        await api("GET", "/v1/promotions", {
          host: shop.host,
          token: manager.token,
        })
      ).status,
    ).toBe(403);
  });
});

describe("discounts", () => {
  test("$700 − $100 = $600, kept on the appointment even if the promotion changes later", async () => {
    const shop = await bookingShop();
    await api("PATCH", `/v1/packages/${shop.pkg}`, {
      ...shop.asOwner,
      body: { priceMinor: 70_000 },
    });
    const id = await promo(shop, {
      type: "fixed",
      value: 10_000,
      code: "CIEN",
    });

    const q = await quote(shop, { package: "corte-barba", code: "cien" });
    expect(q.body).toMatchObject({
      subtotalMinor: 70_000,
      discountMinor: 10_000,
      totalMinor: 60_000,
      promotion: { code: "CIEN" },
    });

    const res = await book(
      shop,
      guestBooking(at(shop, 2, "10:00"), {
        service: undefined,
        package: "corte-barba",
        code: "CIEN",
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      subtotalMinor: 70_000,
      discountMinor: 10_000,
      totalMinor: 60_000,
      promotion: { code: "CIEN", amountMinor: 10_000 },
    });

    await api("PATCH", `/v1/promotions/${id}`, {
      ...shop.asOwner,
      body: { value: 50_000 },
    });
    const after = await api(
      "GET",
      `/v1/appointments/${res.body.id}`,
      shop.asOwner,
    );
    expect(after.body).toMatchObject({
      discountMinor: 10_000,
      totalMinor: 60_000,
    });
  });

  test("percentage, service and package restrictions, expiry and unknown codes", async () => {
    const shop = await bookingShop();
    await promo(shop, { type: "percent", value: 15, code: "QUINCE" });
    await promo(shop, {
      type: "fixed",
      value: 5_000,
      code: "SOLOCORTE",
      serviceIds: [shop.services.corte],
    });
    await promo(shop, {
      type: "fixed",
      value: 5_000,
      code: "PAQUETE",
      packageIds: [shop.pkg],
    });
    await promo(shop, {
      type: "fixed",
      value: 5_000,
      code: "VIEJO",
      endsAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect(
      (await quote(shop, { service: "corte", code: "QUINCE" })).body,
    ).toMatchObject({ discountMinor: 4_500, totalMinor: 25_500 });
    expect(
      (await quote(shop, { service: "corte", code: "SOLOCORTE" })).body,
    ).toMatchObject({ discountMinor: 5_000 });
    expect(
      (await quote(shop, { package: "corte-barba", code: "SOLOCORTE" })).body,
    ).toMatchObject({ discountMinor: 0, rejected: "item" });
    expect(
      (await quote(shop, { package: "corte-barba", code: "PAQUETE" })).body,
    ).toMatchObject({ discountMinor: 5_000 });
    expect(
      (await quote(shop, { service: "corte", code: "PAQUETE" })).body,
    ).toMatchObject({ rejected: "item" });
    expect(
      (await quote(shop, { service: "corte", code: "VIEJO" })).body,
    ).toMatchObject({ rejected: "expired" });
    expect(
      (await quote(shop, { service: "corte", code: "NOEXISTE" })).body,
    ).toMatchObject({ rejected: "unknown_code" });

    const refused = await book(
      shop,
      guestBooking(at(shop, 2, "10:00"), {
        service: undefined,
        package: "corte-barba",
        code: "SOLOCORTE",
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe("PROMOTION_UNAVAILABLE");
  });

  test("a usage limit holds under simultaneous bookings, and a cancellation gives the use back", async () => {
    const shop = await bookingShop();
    const id = await promo(shop, {
      type: "fixed",
      value: 5_000,
      code: "UNO",
      maxRedemptions: 1,
    });
    const results = await Promise.all([
      book(shop, guestBooking(at(shop, 2, "10:00"), { code: "UNO" })),
      book(
        shop,
        guestBooking(at(shop, 2, "10:00"), { code: "UNO", barber: "lucas" }),
      ),
      book(shop, guestBooking(at(shop, 2, "13:00"), { code: "UNO" })),
    ]);
    const won = results.filter((r) => r.status === 201);
    expect(won).toHaveLength(1);
    expect(
      results.filter((r) => r.body.error?.code === "PROMOTION_UNAVAILABLE"),
    ).toHaveLength(2);
    expect(
      (await promotions.findOne({ _id: new ObjectId(id) }))?.redemptions,
    ).toBe(1);

    await api("PATCH", `/v1/appointments/${won[0]?.body.id}`, {
      ...shop.asOwner,
      body: { status: "cancelled" },
    });
    expect(
      (await promotions.findOne({ _id: new ObjectId(id) }))?.redemptions,
    ).toBe(0);
    expect(
      (await book(shop, guestBooking(at(shop, 2, "15:00"), { code: "UNO" })))
        .status,
    ).toBe(201);
  });

  test("per-customer limit, and an automatic first-visit promotion without a code", async () => {
    const shop = await bookingShop();
    await promo(shop, {
      type: "fixed",
      value: 5_000,
      code: "UNAVEZ",
      maxPerCustomer: 1,
    });
    await promo(shop, { type: "percent", value: 20, firstVisitOnly: true });
    const customer = { name: "Ana López", phone: nextPhone() };

    const first = await book(
      shop,
      guestBooking(at(shop, 2, "10:00"), { customer }),
    );
    expect(first.body).toMatchObject({
      discountMinor: 6_000,
      totalMinor: 24_000,
    });
    const second = await book(
      shop,
      guestBooking(at(shop, 2, "13:00"), { customer }),
    );
    expect(second.body).toMatchObject({ discountMinor: 0, totalMinor: 30_000 });

    expect(
      (
        await book(
          shop,
          guestBooking(at(shop, 3, "10:00"), { customer, code: "UNAVEZ" }),
        )
      ).status,
    ).toBe(201);
    const again = await book(
      shop,
      guestBooking(at(shop, 3, "13:00"), { customer, code: "UNAVEZ" }),
    );
    expect(again.status).toBe(409);
    expect(
      (
        await quote(shop, {
          service: "corte",
          code: "UNAVEZ",
          phone: customer.phone,
        })
      ).body,
    ).toMatchObject({ rejected: "customer_limit" });
  });
});
