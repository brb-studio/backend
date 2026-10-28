import type { ClientSession, ObjectId } from "mongodb";
import { forTenant, type TenantDb } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { visibleBranchIds } from "../auth/policy";
import { getBranch } from "../tenancy/service";

export type StockRow = { branchId: string; quantity: number };

/** Units left per product at the branches this user can see. A product with no rows isn't counted. */
export async function stockRows(auth: Auth, productIds: ObjectId[]) {
  const branches = visibleBranchIds(auth);
  const rows = await collect(
    forTenant(auth.tenantId).productStock.find({
      productId: { $in: productIds },
      ...(branches && { branchId: { $in: branches } }),
    }),
  );
  const byProduct = new Map<string, StockRow[]>();
  for (const row of rows) {
    const key = row.productId.toHexString();
    byProduct.set(key, [
      ...(byProduct.get(key) ?? []),
      { branchId: row.branchId.toHexString(), quantity: row.quantity },
    ]);
  }
  return byProduct;
}

/** Sets the units left at one branch; null stops counting the product there. */
export async function setStock(
  auth: Auth,
  productId: ObjectId,
  branchId: ObjectId,
  quantity: number | null,
  now = new Date(),
) {
  const t = forTenant(auth.tenantId);
  await getBranch(auth, branchId);
  const product = await t.products.findOne({
    _id: productId,
    $or: [{ branchId: { $exists: false } }, { branchId }],
  });
  if (!product) throw new AppError(404, "NOT_FOUND", "Not found");
  if (quantity === null) {
    await t.productStock.deleteOne({ productId, branchId });
    return;
  }
  await t.productStock.findOneAndUpdate(
    { productId, branchId },
    { $set: { quantity, updatedAt: now } },
    { upsert: true },
  );
}

/** Takes units for a reservation at one branch. Products with no count there never run out. */
export async function takeStock(
  t: TenantDb,
  product: { _id: ObjectId; slug: string },
  branchId: ObjectId,
  quantity: number,
  session: ClientSession,
  now: Date,
) {
  const taken = await t.productStock.updateOne(
    { productId: product._id, branchId, quantity: { $gte: quantity } },
    { $inc: { quantity: -quantity }, $set: { updatedAt: now } },
    { session },
  );
  if (taken.modifiedCount === 1) return;
  const counted = await t.productStock.countDocuments(
    { productId: product._id, branchId },
    { session },
  );
  if (counted > 0) {
    throw new AppError(409, "OUT_OF_STOCK", "Not enough units left", [
      { path: "items", message: product.slug },
    ]);
  }
}

/** Gives back the units of a reservation that was cancelled or expired, at the branch it was made in. */
export async function returnStock(
  t: TenantDb,
  order: {
    branchId: ObjectId;
    items: { productId: ObjectId; quantity: number }[];
  },
  session: ClientSession,
  now = new Date(),
) {
  for (const item of order.items) {
    await t.productStock.updateOne(
      { productId: item.productId, branchId: order.branchId },
      { $inc: { quantity: item.quantity }, $set: { updatedAt: now } },
      { session },
    );
  }
}
