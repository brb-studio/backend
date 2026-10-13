import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { productOrders, products } from "../src/db/collections";
import { expireOrders } from "../src/features/products/expire";
import {
  addBranch,
  api,
  create,
  createShop,
  createUser,
  type Who,
} from "./helpers";

type Order = {
  id: string;
  status: string;
  code?: string;
  totalMinor: number;
  customer?: { name: string };
  payment?: { method: string };
};

async function shopWithProducts() {
  const shop = await createShop({ products: { enabled: true } });
  // createShop's branch has a random slug; rename it so the tests can name it.
  await api("PATCH", `/v1/branches/${shop.branchId}`, {
    ...shop.asOwner,
    body: { slug: "centro" },
  });
  const wax = await create(shop.asOwner, "/v1/products", {
    slug: "cera",
    name: { es: "Cera" },
    priceMinor: 18_000,
    stock: 2,
  });
  await create(shop.asOwner, "/v1/products", {
    slug: "aceite",
    name: { es: "Aceite" },
    priceMinor: 25_000,
  });
  const customer = async (): Promise<
    Who & { userId: string; name: string }
  > => {
    const { user, token } = await createUser(shop.tenant, "customer");
    return {
      host: shop.host,
      token,
      userId: user._id.toHexString(),
      name: user.name,
    };
  };
  return { shop, wax, customer };
}

const reserve = (who: Who, items: { product: string; quantity: number }[]) =>
  api("POST", "/v1/me/product-orders", {
    ...who,
    body: { branch: "centro", items },
  });
const mine = async (who: Who) =>
  (await api("GET", "/v1/me/product-orders", who)).body as unknown as {
    orders: Order[];
    transfer: { accountKey: string } | null;
  };
const stockOf = async (slug: string, shop: { tenant: { _id: unknown } }) =>
  (await products.findOne({ slug, tenantId: shop.tenant._id as never }))?.stock;

describe("products module", () => {
  test("with the module off nothing about products exists", async () => {
    const shop = await createShop();
    const { token } = await createUser(shop.tenant, "customer");
    for (const [method, path, who] of [
      ["GET", "/v1/public/products", { host: shop.host }],
      ["GET", "/v1/products", shop.asOwner],
      ["GET", "/v1/me/product-orders", { host: shop.host, token }],
      ["GET", "/v1/product-orders", shop.asOwner],
    ] as const) {
      expect((await api(method, path, who)).status).toBe(404);
    }
    expect(
      (await api("GET", "/v1/public/tenant", { host: shop.host })).body
        .products,
    ).toBe(false);

    const on = await api("PATCH", "/v1/tenant", {
      ...shop.asOwner,
      body: { products: { enabled: true } },
    });
    expect(on.body.products).toEqual({ enabled: true });
    expect((await api("GET", "/v1/products", shop.asOwner)).status).toBe(200);
  });

  test("owners manage the catalog; visitors see availability, never the count", async () => {
    const { shop } = await shopWithProducts();
    expect(
      (
        await api("POST", "/v1/products", {
          ...shop.asOwner,
          body: { slug: "cera", name: { es: "Otra" }, priceMinor: 1 },
        })
      ).body.error?.code,
    ).toBe("SLUG_TAKEN");
    const barber = await createUser(shop.tenant, "barber");
    expect(
      (
        await api("POST", "/v1/products", {
          host: shop.host,
          token: barber.token,
          body: { slug: "x", name: { es: "X" }, priceMinor: 1 },
        })
      ).status,
    ).toBe(403);

    const pub = await api("GET", "/v1/public/products", { host: shop.host });
    const list = pub.body.products as {
      slug: string;
      available: boolean;
      stock?: number;
    }[];
    expect(list.map((p) => p.slug)).toEqual(["aceite", "cera"]);
    expect(list.every((p) => p.stock === undefined)).toBe(true);

    const staffList = await api("GET", "/v1/products", shop.asOwner);
    const wax = (
      Object.values(staffList.body) as {
        slug: string;
        id: string;
        stock?: number;
      }[]
    ).find((p) => p.slug === "cera");
    expect(wax?.stock).toBe(2);
    const untracked = await api("PATCH", `/v1/products/${wax?.id}`, {
      ...shop.asOwner,
      body: { stock: null, category: "Cabello" },
    });
    expect(untracked.body.stock).toBeUndefined();
    expect(untracked.body.category).toBe("Cabello");
  });

  test("reserving takes units atomically; cancelling gives them back", async () => {
    const { shop, customer } = await shopWithProducts();
    const ana = await customer();
    const beto = await customer();

    expect(
      (
        await api("POST", "/v1/me/product-orders", {
          host: shop.host,
          body: {},
        })
      ).status,
    ).toBe(401);
    expect(
      (await reserve(ana, [{ product: "nope", quantity: 1 }])).status,
    ).toBe(422);

    const first = await reserve(ana, [
      { product: "cera", quantity: 2 },
      { product: "aceite", quantity: 1 },
    ]);
    expect(first.status).toBe(201);
    expect(await stockOf("cera", shop)).toBe(0);
    expect(
      (await reserve(beto, [{ product: "cera", quantity: 1 }])).body.error
        ?.code,
    ).toBe("OUT_OF_STOCK");
    expect((await mine(beto)).orders).toHaveLength(0);

    const [order] = (await mine(ana)).orders;
    expect(order).toMatchObject({ status: "reserved", totalMinor: 61_000 });
    expect(order?.code).toBeString();

    expect(
      (await api("POST", `/v1/me/product-orders/${order?.id}/cancel`, beto))
        .status,
    ).toBe(404);
    expect(
      (await api("POST", `/v1/me/product-orders/${order?.id}/cancel`, ana))
        .status,
    ).toBe(204);
    expect(await stockOf("cera", shop)).toBe(2);
    expect(
      (await api("POST", `/v1/me/product-orders/${order?.id}/cancel`, ana)).body
        .error?.code,
    ).toBe("NOT_RESERVED");
    expect((await mine(ana)).orders[0]).toMatchObject({ status: "cancelled" });
    expect((await mine(ana)).orders[0]?.code).toBeUndefined();
  });

  test("at most three open reservations per customer", async () => {
    const { customer } = await shopWithProducts();
    const ana = await customer();
    for (let i = 0; i < 3; i++) {
      expect(
        (await reserve(ana, [{ product: "aceite", quantity: 1 }])).status,
      ).toBe(201);
    }
    expect(
      (await reserve(ana, [{ product: "aceite", quantity: 1 }])).body.error
        ?.code,
    ).toBe("TOO_MANY_RESERVATIONS");
  });

  test("staff scan the QR, hand over and record cash or transfer; only once, only at their branch", async () => {
    const { shop, customer } = await shopWithProducts();
    const ana = await customer();
    await reserve(ana, [{ product: "cera", quantity: 1 }]);
    const code = (await mine(ana)).orders[0]?.code ?? "";

    const barber = await createUser(shop.tenant, "barber", {
      branchId: new ObjectId(shop.branchId),
    });
    const asBarber = { host: shop.host, token: barber.token };
    // The same shop's second branch has its own staff, who can't see this branch's reservations.
    const north = await addBranch(shop.host, shop.owner.token, {
      slug: "norte",
      name: "Norte",
    });
    const other = await createUser(shop.tenant, "manager", {
      branchId: new ObjectId(north),
    });
    const asOther = { host: shop.host, token: other.token };

    const scan = (who: Who, value: string) =>
      api("POST", "/v1/product-orders/scan", { ...who, body: { code: value } });
    expect((await scan(asBarber, "garbage")).status).toBe(404);
    expect((await scan(asBarber, `${code}x`)).status).toBe(404);
    expect((await scan(asOther, code)).status).toBe(404);
    expect(
      Object.values((await api("GET", "/v1/product-orders", asOther)).body),
    ).toHaveLength(0);

    const scanned = await scan(asBarber, code);
    expect(scanned.body).toMatchObject({
      status: "reserved",
      customer: { name: ana.name },
    });
    expect(
      Object.values((await api("GET", "/v1/product-orders", asBarber)).body),
    ).toHaveLength(1);
    // Reading changes nothing.
    expect((await mine(ana)).orders[0]?.status).toBe("reserved");

    const id = String(scanned.body.id);
    expect(
      (
        await api("POST", `/v1/product-orders/${id}/deliver`, {
          ...asOther,
          body: { method: "cash" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("POST", `/v1/product-orders/${id}/deliver`, {
          ...asBarber,
          body: { method: "card" },
        })
      ).status,
    ).toBe(422);
    const delivered = await api("POST", `/v1/product-orders/${id}/deliver`, {
      ...asBarber,
      body: { method: "spei" },
    });
    expect(delivered.body).toMatchObject({
      status: "delivered",
      payment: { method: "spei" },
    });
    expect(delivered.body.code).toBeUndefined();
    expect(
      (
        await api("POST", `/v1/product-orders/${id}/deliver`, {
          ...asBarber,
          body: { method: "cash" },
        })
      ).body.error?.code,
    ).toBe("NOT_RESERVED");
    expect(
      Object.values((await api("GET", "/v1/product-orders", asBarber)).body),
    ).toHaveLength(0);
    // Delivered units stay out of stock; the customer can't cancel what they already took.
    expect(await stockOf("cera", shop)).toBe(1);
    expect(
      (await api("POST", `/v1/me/product-orders/${id}/cancel`, ana)).body.error
        ?.code,
    ).toBe("NOT_RESERVED");
  });

  test("a reservation nobody claims expires and returns its units, once", async () => {
    const { shop, customer } = await shopWithProducts();
    const ana = await customer();
    await reserve(ana, [{ product: "cera", quantity: 2 }]);
    expect(await stockOf("cera", shop)).toBe(0);

    await expireOrders(shop.tenant);
    expect(await stockOf("cera", shop)).toBe(0);

    await productOrders.updateMany(
      { tenantId: shop.tenant._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await expireOrders({ _id: shop.tenant._id, products: { enabled: true } });
    await expireOrders({ _id: shop.tenant._id, products: { enabled: true } });
    expect(await stockOf("cera", shop)).toBe(2);
    expect((await mine(ana)).orders[0]?.status).toBe("expired");
  });

  test("transfer details are shown only when the shop takes transfers", async () => {
    const shop = await createShop({
      products: { enabled: true },
      bankTransferEnabled: true,
      bankAccountKey: "012345678901234567",
      bankAccountHolder: "Barbería",
    });
    const { token } = await createUser(shop.tenant, "customer");
    expect((await mine({ host: shop.host, token })).transfer).toMatchObject({
      accountKey: "012345678901234567",
    });
    const plain = await shopWithProducts();
    expect((await mine(await plain.customer())).transfer).toBeNull();
  });
});
