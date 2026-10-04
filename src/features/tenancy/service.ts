import { type Filter, ObjectId } from "mongodb";
import type * as z from "zod";
import { config } from "../../config";
import {
  type BranchDoc,
  forTenant,
  platform,
  type TenantDoc,
} from "../../db/scoped";
import { AppError, type Auth, isDuplicate } from "../../shared/http";
import { photos } from "../../shared/photos";
import { isTenantWide, visibleBranchIds } from "../auth/policy";
import {
  type branchCreate,
  type branchUpdate,
  SLUG,
  type tenantUpdate,
} from "./schemas";

export function tenantQuery(
  rawHost: string | undefined,
  platformDomain = config.PLATFORM_DOMAIN,
): Filter<TenantDoc> | null {
  const host = rawHost
    ?.split(",")[0]
    ?.trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  if (!host || !/^[a-z0-9.-]+$/.test(host) || host === platformDomain) {
    return null;
  }
  const suffix = `.${platformDomain}`;
  if (!host.endsWith(suffix)) return { customDomain: host };
  const slug = host.slice(0, -suffix.length);
  return SLUG.test(slug) ? { slug } : null;
}

export async function tenantForHost(host: string | undefined) {
  const query = tenantQuery(host);
  return query && platform.tenants.findOne(query);
}

export async function updateTenant(
  tenant: TenantDoc,
  input: z.output<typeof tenantUpdate>,
) {
  const updated = await platform.tenants.findOneAndUpdate(
    { _id: tenant._id },
    { $set: { ...input, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
  if (!updated) throw new AppError(404, "TENANT_NOT_FOUND", "Unknown tenant");
  return updated;
}

const visibleTo = (auth: Auth): Filter<BranchDoc> => {
  const ids = visibleBranchIds(auth);
  return ids ? { _id: { $in: ids } } : {};
};

export const listBranches = (auth: Auth) =>
  forTenant(auth.tenantId)
    .branches.find(visibleTo(auth))
    .sort({ name: 1 })
    .toArray();

export async function getBranch(auth: Auth, id: ObjectId) {
  const branch = await forTenant(auth.tenantId).branches.findOne({
    $and: [{ _id: id }, visibleTo(auth)],
  });
  if (!branch) throw new AppError(404, "NOT_FOUND", "Not found");
  return branch;
}

async function assertBranchSlot(tenant: TenantDoc, except?: ObjectId) {
  const active = await forTenant(tenant._id).branches.countDocuments({
    active: true,
    ...(except && { _id: { $ne: except } }),
  });
  if (active >= tenant.subscription.limits.branches) {
    throw new AppError(402, "PLAN_LIMIT", "Branch limit reached for this plan");
  }
}

const slugTaken = (err: unknown) => {
  if (isDuplicate(err)) {
    return new AppError(409, "SLUG_TAKEN", "Another branch uses this slug");
  }
  return err;
};

export async function createBranch(
  tenant: TenantDoc,
  input: z.output<typeof branchCreate>,
) {
  await assertBranchSlot(tenant);
  const now = new Date();
  const branch: BranchDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    ...input,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await forTenant(tenant._id)
    .branches.insertOne(branch)
    .catch((err) => {
      throw slugTaken(err);
    });
  return branch;
}

export async function updateBranch(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof branchUpdate>,
) {
  const { booking, ...fields } = input;
  if (fields.active !== undefined && !isTenantWide(auth)) {
    throw new AppError(403, "FORBIDDEN", "Not allowed");
  }
  if (fields.active) await assertBranchSlot(tenant, id);
  const bookingPaths = Object.fromEntries(
    Object.entries(booking ?? {}).map(([key, value]) => [
      `booking.${key}`,
      value,
    ]),
  );
  const branch = await forTenant(tenant._id)
    .branches.findOneAndUpdate(
      { $and: [{ _id: id }, visibleTo(auth)] },
      {
        $set: { ...fields, ...bookingPaths, updatedAt: new Date() },
        // A saved gallery replaces the single photo of older documents.
        ...(fields.images && { $unset: { image: "" } }),
      },
      { returnDocument: "after" },
    )
    .catch((err) => {
      throw slugTaken(err);
    });
  if (!branch) throw new AppError(404, "NOT_FOUND", "Not found");
  return branch;
}

export async function publicTenant(tenant: TenantDoc) {
  const branches = await forTenant(tenant._id)
    .branches.find({ active: true })
    .sort({ name: 1 })
    .toArray();
  return {
    slug: tenant.slug,
    name: tenant.name,
    currency: tenant.currency,
    locales: tenant.locales,
    defaultLocale: tenant.defaultLocale,
    theme: tenant.theme ?? {},
    brand: tenant.brand,
    branches: branches.map(({ active: _, ...branch }) => toBranch(branch)),
  };
}

export const toTenant = (tenant: TenantDoc) => ({
  slug: tenant.slug,
  name: tenant.name,
  customDomain: tenant.customDomain,
  currency: tenant.currency,
  locales: tenant.locales,
  defaultLocale: tenant.defaultLocale,
  theme: tenant.theme ?? {},
  brand: tenant.brand,
  subscription: tenant.subscription,
});

export const toBranch = ({
  _id,
  tenantId: _,
  createdAt: __,
  updatedAt: ___,
  ...branch
}: Omit<BranchDoc, "active"> & { active?: boolean }) => ({
  id: _id.toHexString(),
  ...branch,
  ...photos(branch),
});
