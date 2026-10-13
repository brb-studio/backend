import { type Filter, ObjectId } from "mongodb";
import type * as z from "zod";
import { forTenant, type ProductDoc, type TenantDoc } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth, duplicateKeys } from "../../shared/http";
import { photos } from "../../shared/photos";
import { visibleBranchIds } from "../auth/policy";
import { getBranch } from "../tenancy/service";
import type { productCreate, productUpdate } from "./schemas";

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
  const { category, stock, ...rest } = input;
  const updated = await forTenant(auth.tenantId)
    .products.findOneAndUpdate(
      { $and: [{ _id: id }, visibleTo(auth)] },
      {
        $set: {
          ...rest,
          ...(category && { category }),
          ...(stock !== undefined && stock !== null && { stock }),
          updatedAt: new Date(),
        },
        $unset: {
          ...(category === null && { category: "" }),
          ...(stock === null && { stock: "" }),
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
  return {
    currency: tenant.currency,
    products: list.map((p) => ({
      slug: p.slug,
      name: p.name,
      description: p.description,
      priceMinor: p.priceMinor,
      category: p.category,
      ...photos(p),
      available: p.stock === undefined || p.stock > 0,
    })),
  };
}

export const toProduct = ({
  _id,
  tenantId: _,
  branchId,
  createdAt: __,
  updatedAt: ___,
  ...product
}: ProductDoc) => ({
  id: _id.toHexString(),
  ...product,
  ...(branchId && { branchId: branchId.toHexString() }),
  ...photos(product),
});
