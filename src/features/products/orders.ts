import { type ClientSession, ObjectId } from "mongodb";
import type * as z from "zod";
import {
  forTenant,
  type ProductOrderDoc,
  type TenantDb,
  type TenantDoc,
  transaction,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { expiryFrom, MAX_OPEN, mergeLines, totalOf } from "./rules";
import type { reserveBody } from "./schemas";
import { orderCode } from "./token";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");
const notReserved = () =>
  new AppError(409, "NOT_RESERVED", "This reservation is no longer open");

export async function restock(
  t: TenantDb,
  order: Pick<ProductOrderDoc, "items">,
  session: ClientSession,
) {
  for (const item of order.items) {
    await t.products.updateOne(
      { _id: item.productId, stock: { $exists: true } },
      { $inc: { stock: item.quantity } },
      { session },
    );
  }
}

export async function releaseOrder(
  t: TenantDb,
  order: Pick<ProductOrderDoc, "_id" | "items">,
  status: "cancelled" | "expired",
  by?: ObjectId,
) {
  await transaction(async (session) => {
    const now = new Date();
    const closed = await t.productOrders.updateOne(
      { _id: order._id, status: "reserved" },
      {
        $set: {
          status,
          closedAt: now,
          ...(by && { closedBy: by }),
          updatedAt: now,
        },
      },
      { session },
    );
    if (closed.modifiedCount === 0) throw notReserved();
    await restock(t, order, session);
  });
}

export async function reserveProducts(
  tenant: TenantDoc,
  auth: Auth,
  input: z.output<typeof reserveBody>,
) {
  const t = forTenant(tenant._id);
  const branch = await t.branches.findOne({ slug: input.branch, active: true });
  if (!branch) throw notFound();
  const open = await t.productOrders.countDocuments({
    customerId: auth.userId,
    status: "reserved",
  });
  if (open >= MAX_OPEN) {
    throw new AppError(
      409,
      "TOO_MANY_RESERVATIONS",
      "Too many open reservations",
    );
  }

  const lines = mergeLines(input.items);
  const found = await collect(
    t.products.find({
      slug: { $in: [...lines.keys()] },
      active: true,
      $or: [{ branchId: { $exists: false } }, { branchId: branch._id }],
    }),
  );
  if (found.length !== lines.size) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "items", message: "unknown product" },
    ]);
  }
  const items = found.map((p) => ({
    productId: p._id,
    name: p.name,
    priceMinor: p.priceMinor,
    quantity: lines.get(p.slug) ?? 1,
  }));
  const now = new Date();
  const order: Omit<ProductOrderDoc, "tenantId"> = {
    _id: new ObjectId(),
    branchId: branch._id,
    customerId: auth.userId,
    status: "reserved",
    items,
    currency: tenant.currency,
    totalMinor: totalOf(items),
    expiresAt: expiryFrom(now),
    createdAt: now,
    updatedAt: now,
  };

  await transaction(async (session) => {
    for (const item of items) {
      const product = found.find((p) => p._id.equals(item.productId));
      if (product?.stock === undefined) continue;
      const taken = await t.products.updateOne(
        { _id: item.productId, stock: { $gte: item.quantity } },
        { $inc: { stock: -item.quantity }, $set: { updatedAt: now } },
        { session },
      );
      if (taken.modifiedCount === 0) {
        throw new AppError(409, "OUT_OF_STOCK", "Not enough units left", [
          { path: "items", message: product.slug },
        ]);
      }
    }
    await t.productOrders.insertOne(order, { session });
  });
  return order._id;
}

export type OrderContext = {
  branch?: { slug: string; name: string };
  customer?: { name: string; phone?: string };
};

export const orderView = (
  order: ProductOrderDoc,
  { branch, customer }: OrderContext = {},
) => ({
  id: order._id.toHexString(),
  status: order.status,
  ...(order.status === "reserved" && { code: orderCode(order._id) }),
  ...(branch && { branch }),
  ...(customer && { customer }),
  items: order.items.map((i) => ({
    name: i.name,
    priceMinor: i.priceMinor,
    quantity: i.quantity,
  })),
  currency: order.currency,
  totalMinor: order.totalMinor,
  expiresAt: order.expiresAt.toISOString(),
  ...(order.payment && {
    payment: {
      method: order.payment.method,
      at: order.payment.at.toISOString(),
    },
  }),
  createdAt: order.createdAt.toISOString(),
});

export const transferOf = (tenant: TenantDoc) =>
  tenant.bankTransferEnabled &&
  tenant.bankAccountKey &&
  tenant.bankAccountHolder
    ? { accountKey: tenant.bankAccountKey, holder: tenant.bankAccountHolder }
    : null;

export async function listMyOrders(tenant: TenantDoc, auth: Auth) {
  const t = forTenant(tenant._id);
  const orders = await collect(
    t.productOrders
      .find({ customerId: auth.userId })
      .sort({ createdAt: -1 })
      .limit(20),
  );
  const names = new Map<string, { slug: string; name: string }>();
  for (const o of orders) {
    const key = o.branchId.toHexString();
    if (names.has(key)) continue;
    const branch = await t.branches.findOne(
      { _id: o.branchId },
      { projection: { slug: 1, name: 1 } },
    );
    if (branch) names.set(key, { slug: branch.slug, name: branch.name });
  }
  return {
    transfer: transferOf(tenant),
    orders: orders.map((o) =>
      orderView(o, { branch: names.get(o.branchId.toHexString()) }),
    ),
  };
}

export async function cancelMyOrder(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
) {
  const t = forTenant(tenant._id);
  const order = await t.productOrders.findOne({
    _id: id,
    customerId: auth.userId,
  });
  if (!order) throw notFound();
  await releaseOrder(t, order, "cancelled", auth.userId);
}
