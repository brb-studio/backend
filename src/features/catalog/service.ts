import { type Filter, ObjectId } from "mongodb";
import type * as z from "zod";
import {
  forTenant,
  type PackageDoc,
  type ServiceDoc,
  type TenantDoc,
} from "../../db/scoped";
import { AppError, type Auth, duplicateKeys } from "../../shared/http";
import { photos } from "../../shared/photos";
import { visibleBranchIds } from "../auth/policy";
import { getBranch } from "../tenancy/service";
import {
  fitsBranch,
  offers,
  packageServices,
  type Request,
  totals,
} from "./rules";
import type {
  packageCreate,
  packageUpdate,
  serviceCreate,
  serviceUpdate,
} from "./schemas";

const ORDER = { position: 1, slug: 1 } as const;
const notFound = () => new AppError(404, "NOT_FOUND", "Not found");
const invalid = (path: string, message: string) =>
  new AppError(422, "VALIDATION", "Invalid request", [{ path, message }]);
const slugTaken = (err: unknown) =>
  duplicateKeys(err).includes("slug")
    ? new AppError(409, "SLUG_TAKEN", "Another item uses this slug")
    : err;

function visibleTo<T extends ServiceDoc | PackageDoc>(auth: Auth): Filter<T> {
  const ids = visibleBranchIds(auth);
  return (
    ids
      ? { $or: [{ branchId: { $exists: false } }, { branchId: { $in: ids } }] }
      : {}
  ) as Filter<T>;
}

export async function servicesFor(
  tenantId: ObjectId,
  ids: ObjectId[],
  branchId: ObjectId | undefined,
  path: string,
  { active = false } = {},
) {
  const found = await forTenant(tenantId)
    .services.find({ _id: { $in: ids } })
    .toArray();
  const list = packageServices(
    { items: ids.map((serviceId) => ({ serviceId })) },
    found,
  );
  if (!list) throw invalid(path, "unknown service");
  if (list.some((s) => (branchId ? !fitsBranch(s, branchId) : s.branchId))) {
    throw invalid(
      path,
      branchId
        ? "a service belongs to another branch"
        : "an item for every branch can only hold services for every branch",
    );
  }
  if (active && list.some((s) => !s.active)) {
    throw invalid(path, "a service is inactive");
  }
  return list;
}

export const listServices = (auth: Auth) =>
  forTenant(auth.tenantId)
    .services.find(visibleTo<ServiceDoc>(auth))
    .sort(ORDER)
    .toArray();

export async function getService(auth: Auth, id: ObjectId) {
  const service = await forTenant(auth.tenantId).services.findOne({
    $and: [{ _id: id }, visibleTo<ServiceDoc>(auth)],
  });
  if (!service) throw notFound();
  return service;
}

export async function createService(
  auth: Auth,
  input: z.output<typeof serviceCreate>,
) {
  if (input.branchId) await getBranch(auth, input.branchId);
  const now = new Date();
  const service: ServiceDoc = {
    _id: new ObjectId(),
    tenantId: auth.tenantId,
    ...input,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await forTenant(auth.tenantId)
    .services.insertOne(service)
    .catch((err) => {
      throw slugTaken(err);
    });
  return service;
}

export async function updateService(
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof serviceUpdate>,
) {
  const updated = await forTenant(auth.tenantId)
    .services.findOneAndUpdate(
      { _id: id },
      {
        $set: { ...input, updatedAt: new Date() },
        // A saved gallery replaces the single photo of older documents.
        ...(input.images && { $unset: { image: "" } }),
      },
      { returnDocument: "after" },
    )
    .catch((err) => {
      throw slugTaken(err);
    });
  if (!updated) throw notFound();
  return updated;
}

async function withTotals(tenantId: ObjectId, pkgs: PackageDoc[]) {
  const ids = pkgs.flatMap((p) => p.items.map((item) => item.serviceId));
  const services = await forTenant(tenantId)
    .services.find({ _id: { $in: ids } })
    .toArray();
  return pkgs.map((p) => toPackage(p, packageServices(p, services)));
}

export async function listPackages(auth: Auth) {
  const pkgs = await forTenant(auth.tenantId)
    .packages.find(visibleTo<PackageDoc>(auth))
    .sort(ORDER)
    .toArray();
  return withTotals(auth.tenantId, pkgs);
}

async function findPackage(auth: Auth, id: ObjectId) {
  const pkg = await forTenant(auth.tenantId).packages.findOne({
    $and: [{ _id: id }, visibleTo<PackageDoc>(auth)],
  });
  if (!pkg) throw notFound();
  return pkg;
}

export async function getPackage(auth: Auth, id: ObjectId) {
  const [pkg] = await withTotals(auth.tenantId, [await findPackage(auth, id)]);
  return pkg;
}

export async function createPackage(
  auth: Auth,
  input: z.output<typeof packageCreate>,
) {
  if (input.branchId) await getBranch(auth, input.branchId);
  const services = await servicesFor(
    auth.tenantId,
    input.items.map((item) => item.serviceId),
    input.branchId,
    "items",
    { active: true },
  );
  const now = new Date();
  const pkg: PackageDoc = {
    _id: new ObjectId(),
    tenantId: auth.tenantId,
    ...input,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await forTenant(auth.tenantId)
    .packages.insertOne(pkg)
    .catch((err) => {
      throw slugTaken(err);
    });
  return toPackage(pkg, services);
}

export async function updatePackage(
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof packageUpdate>,
) {
  const pkg = await findPackage(auth, id);
  if (input.items) {
    await servicesFor(
      auth.tenantId,
      input.items.map((item) => item.serviceId),
      pkg.branchId,
      "items",
      { active: true },
    );
  }
  const updated = await forTenant(auth.tenantId)
    .packages.findOneAndUpdate(
      { _id: id },
      {
        $set: { ...input, updatedAt: new Date() },
        // A saved gallery replaces the single photo of older documents.
        ...(input.images && { $unset: { image: "" } }),
      },
      { returnDocument: "after" },
    )
    .catch((err) => {
      throw slugTaken(err);
    });
  if (!updated) throw notFound();
  const [result] = await withTotals(auth.tenantId, [updated]);
  return result;
}

export async function publicCatalog(tenant: TenantDoc, branchSlug?: string) {
  const t = forTenant(tenant._id);
  const branches = await t.branches
    .find({ active: true, ...(branchSlug && { slug: branchSlug }) })
    .toArray();
  if (branchSlug && branches.length === 0) throw notFound();
  const [barbers, services, pkgs] = await Promise.all([
    t.barbers
      .find({ active: true, branchId: { $in: branches.map((b) => b._id) } })
      .toArray(),
    t.services.find({ active: true }).sort(ORDER).toArray(),
    t.packages.find({ active: true }).sort(ORDER).toArray(),
  ]);
  return {
    currency: tenant.currency,
    services: services
      .filter((s) => barbers.some((b) => offers(b, [s])))
      .map(toPublicService),
    packages: pkgs.flatMap((p) => {
      const list = packageServices(p, services);
      const bookable =
        list &&
        barbers.some((b) => fitsBranch(p, b.branchId) && offers(b, list));
      return bookable ? [toPublicPackage(p, list)] : [];
    }),
  };
}

export async function resolveRequest(
  tenantId: ObjectId,
  request: {
    service?: string;
    package?: string;
    serviceId?: ObjectId;
    packageId?: ObjectId;
  },
): Promise<Request> {
  const t = forTenant(tenantId);
  if (request.service || request.serviceId) {
    const service = await t.services.findOne({
      ...(request.service
        ? { slug: request.service }
        : { _id: request.serviceId }),
      active: true,
    });
    if (!service) throw notFound();
    return { services: [service] };
  }
  if (!request.package && !request.packageId) throw notFound();
  const pkg = await t.packages.findOne({
    ...(request.package
      ? { slug: request.package }
      : { _id: request.packageId }),
    active: true,
  });
  const services = pkg
    ? packageServices(
        pkg,
        await t.services
          .find({
            _id: { $in: pkg.items.map((i) => i.serviceId) },
            active: true,
          })
          .toArray(),
      )
    : null;
  if (!pkg || !services) throw notFound();
  return { services, pkg };
}

export const toService = (s: ServiceDoc) => ({
  id: s._id.toHexString(),
  ...(s.branchId && { branchId: s.branchId.toHexString() }),
  slug: s.slug,
  name: s.name,
  description: s.description,
  durationMin: s.durationMin,
  priceMinor: s.priceMinor,
  ...photos(s),
  position: s.position,
  active: s.active,
});

const toPackage = (p: PackageDoc, services: ServiceDoc[] | null) => ({
  id: p._id.toHexString(),
  ...(p.branchId && { branchId: p.branchId.toHexString() }),
  slug: p.slug,
  name: p.name,
  description: p.description,
  priceMinor: p.priceMinor,
  ...photos(p),
  position: p.position,
  active: p.active,
  items: p.items.map((item) => ({ serviceId: item.serviceId.toHexString() })),
  ...(services
    ? totals(services)
    : { durationMin: null, listPriceMinor: null }),
  servicesActive: !!services && services.every((s) => s.active),
});

const toPublicService = (s: ServiceDoc) => ({
  id: s._id.toHexString(),
  slug: s.slug,
  name: s.name,
  description: s.description,
  durationMin: s.durationMin,
  priceMinor: s.priceMinor,
  ...photos(s),
});

const toPublicPackage = (p: PackageDoc, services: ServiceDoc[]) => ({
  id: p._id.toHexString(),
  slug: p.slug,
  name: p.name,
  description: p.description,
  priceMinor: p.priceMinor,
  ...photos(p),
  ...totals(services),
  services: services.map((s) => ({
    id: s._id.toHexString(),
    slug: s.slug,
    name: s.name,
    durationMin: s.durationMin,
  })),
});
