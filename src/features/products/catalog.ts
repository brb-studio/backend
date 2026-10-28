import { type Filter, ObjectId } from "mongodb";
import type * as z from "zod";
import { forTenant, type ProductDoc, type TenantDoc } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth, duplicateKeys } from "../../shared/http";
import { photos } from "../../shared/photos";
import { visibleBranchIds } from "../auth/policy";
import { getBranch } from "../tenancy/service";
import type { productCreate, productUpdate } from "./schemas";
import type { StockRow } from "./stock";

const ORDER = { position: 1, slug: 1 } as const;
const notFound = () => new AppError(404, "NOT_FOUND", "Not found");
const slugTaken = (err: unknown) =>
  duplicateKeys(err).includes("slug")
    ? new AppError(409, "SLUG_TAKEN", "Another product uses this slug")
    : err;

function visibleTo(auth: Auth): Filter<ProductDoc> {
  const ids = visibleBranchIds(auth);
  return ids
    ? { $or: [{ branchId: { $exists: false } }, { branchId: { $in: ids } }] }
    : {};
}

export const listProducts = (auth: Auth) =>
  collect(forTenant(auth.tenantId).products.find(visibleTo(auth)).sort(ORDER));

export async function createProduct(
  auth: Auth,
  input: z.output<typeof productCreate>,
) {
  const { branchId, ...rest } = input;
  const branch = branchId ? new ObjectId(branchId) : undefined;
  if (branch) await getBranch(auth, branch);
  const now = new Date();
  const product: ProductDoc = {
    _id: new ObjectId(),
    tenantId: auth.tenantId,
    ...rest,
    ...(branch && { branchId: branch }),
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await forTenant(auth.tenantId)
    .products.insertOne(product)
    .catch((err) => {
      throw slugTaken(err);
    });
  return product;
}

export async function updateProduct(
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof productUpdate>,
) {
  const { category, ...rest } = input;
  const updated = await forTenant(auth.tenantId)
    .products.findOneAndUpdate(
      { $and: [{ _id: id }, visibleTo(auth)] },
      {
        $set: {
          ...rest,
          ...(category && { category }),
          updatedAt: new Date(),
        },
        $unset: {
          ...(category === null && { category: "" }),
          // A saved gallery replaces the single photo of older documents.
          ...(rest.images && { image: "" }),
        },
      },
      { returnDocument: "after" },
    )
    .catch((err) => {
      throw slugTaken(err);
    });
  if (!updated) throw notFound();
  return updated;
}

export async function publicProducts(tenant: TenantDoc, branchSlug?: string) {
  const t = forTenant(tenant._id);
  const branch = branchSlug
    ? await t.branches.findOne({ slug: branchSlug, active: true })
    : undefined;
  if (branchSlug && !branch) throw notFound();
  const list = await collect(
    t.products
      .find({
        active: true,
        ...(branch && {
          $or: [{ branchId: { $exists: false } }, { branchId: branch._id }],
        }),
      })
      .sort(ORDER),
  );
  // With a branch, only its counts matter; without one, a product is available if any branch has units.
  const counts = await collect(
    t.productStock.find({
      productId: { $in: list.map((p) => p._id) },
      ...(branch && { branchId: branch._id }),
    }),
  );
  const quantities = new Map<string, number[]>();
  for (const row of counts) {
    const key = row.productId.toHexString();
    quantities.set(key, [...(quantities.get(key) ?? []), row.quantity]);
  }
  return {
    currency: tenant.currency,
    products: list.map((p) => {
      const counted = quantities.get(p._id.toHexString()) ?? [];
      return {
        slug: p.slug,
        name: p.name,
        description: p.description,
        priceMinor: p.priceMinor,
        category: p.category,
        ...photos(p),
        available: counted.length === 0 || counted.some((q) => q > 0),
      };
    }),
  };
}

export const toProduct = (
  {
    _id,
    tenantId: _,
    branchId,
    createdAt: __,
    updatedAt: ___,
    ...product
  }: ProductDoc,
  stock: StockRow[],
) => ({
  id: _id.toHexString(),
  ...product,
  ...(branchId && { branchId: branchId.toHexString() }),
  stock,
  ...photos(product),
});
