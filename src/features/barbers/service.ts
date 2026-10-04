import { type Filter, ObjectId } from "mongodb";
import type * as z from "zod";
import { type BarberDoc, forTenant, type TenantDoc } from "../../db/scoped";
import { AppError, type Auth, duplicateKeys } from "../../shared/http";
import { photos } from "../../shared/photos";
import { visibleBranchIds } from "../auth/policy";
import { canServe } from "../catalog/rules";
import { resolveRequest, servicesFor } from "../catalog/service";
import { getBranch } from "../tenancy/service";
import type { barberCreate, barberUpdate } from "./schemas";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

async function offeredServices(
  tenantId: ObjectId,
  ids: ObjectId[],
  branchId: ObjectId,
) {
  const services = await servicesFor(tenantId, ids, branchId, "serviceIds");
  return [
    ...new Map(services.map((s) => [s._id.toHexString(), s._id])).values(),
  ];
}

const visibleTo = (auth: Auth): Filter<BarberDoc> => {
  const ids = visibleBranchIds(auth);
  return ids ? { branchId: { $in: ids } } : {};
};

export const listBarbers = (auth: Auth, branchId?: ObjectId) =>
  forTenant(auth.tenantId)
    .barbers.find({ $and: [visibleTo(auth), branchId ? { branchId } : {}] })
    .sort({ name: 1 })
    .toArray();

export async function getBarber(auth: Auth, id: ObjectId) {
  const barber = await forTenant(auth.tenantId).barbers.findOne({
    $and: [{ _id: id }, visibleTo(auth)],
  });
  if (!barber) throw notFound();
  return barber;
}

async function assertBarberSlot(tenant: TenantDoc, except?: ObjectId) {
  const active = await forTenant(tenant._id).barbers.countDocuments({
    active: true,
    ...(except && { _id: { $ne: except } }),
  });
  if (active >= tenant.subscription.limits.barbers) {
    throw new AppError(402, "PLAN_LIMIT", "Barber limit reached for this plan");
  }
}

async function assertLinkable(
  auth: Auth,
  userId: ObjectId,
  branchId: ObjectId,
) {
  const user = await forTenant(auth.tenantId).users.findOne({ _id: userId });
  if (user?.role !== "barber" || !user.branchId?.equals(branchId)) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      {
        path: "userId",
        message: "must be a barber account of the same branch",
      },
    ]);
  }
}

const conflict = (err: unknown) => {
  const keys = duplicateKeys(err);
  if (keys.includes("userId")) {
    return new AppError(
      409,
      "USER_LINKED",
      "That account already has a barber profile",
    );
  }
  if (keys.includes("slug")) {
    return new AppError(409, "SLUG_TAKEN", "Another barber uses this slug");
  }
  return err;
};

export async function createBarber(
  tenant: TenantDoc,
  auth: Auth,
  input: z.output<typeof barberCreate>,
) {
  const branch = await getBranch(auth, input.branchId);
  await assertBarberSlot(tenant);
  if (input.userId) await assertLinkable(auth, input.userId, branch._id);
  const now = new Date();
  const barber: BarberDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    ...input,
    branchId: branch._id,
    hours: input.hours ?? branch.hours,
    serviceIds: input.serviceIds
      ? await offeredServices(tenant._id, input.serviceIds, branch._id)
      : [],
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await forTenant(tenant._id)
    .barbers.insertOne(barber)
    .catch((err) => {
      throw conflict(err);
    });
  return barber;
}

export async function updateBarber(
  tenant: TenantDoc,
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof barberUpdate>,
) {
  const barber = await getBarber(auth, id);
  if (input.active) await assertBarberSlot(tenant, id);
  const { userId, serviceIds, ...fields } = input;
  if (userId) await assertLinkable(auth, userId, barber.branchId);
  const offered =
    serviceIds &&
    (await offeredServices(tenant._id, serviceIds, barber.branchId));
  const updated = await forTenant(tenant._id)
    .barbers.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          ...fields,
          ...(userId && { userId }),
          ...(offered && { serviceIds: offered }),
          updatedAt: new Date(),
        },
        ...((userId === null || fields.images) && {
          $unset: {
            ...(userId === null && { userId: "" }),
            // A saved gallery replaces the single photo of older documents.
            ...(fields.images && { image: "" }),
          },
        }),
      },
      { returnDocument: "after" },
    )
    .catch((err) => {
      throw conflict(err);
    });
  if (!updated) throw notFound();
  return updated;
}

export async function publicBarbers(
  tenant: TenantDoc,
  query: { branch?: string; service?: string; package?: string },
) {
  const t = forTenant(tenant._id);
  const branches = await t.branches
    .find({ active: true, ...(query.branch && { slug: query.branch }) })
    .toArray();
  if (query.branch && branches.length === 0) throw notFound();
  const request =
    (query.service || query.package) &&
    (await resolveRequest(tenant._id, query));
  const slugOf = new Map(branches.map((b) => [b._id.toHexString(), b.slug]));
  const barbers = await t.barbers
    .find({ active: true, branchId: { $in: branches.map((b) => b._id) } })
    .sort({ name: 1 })
    .toArray();
  const able = request ? barbers.filter((b) => canServe(b, request)) : barbers;
  return able.map((b) => ({
    id: b._id.toHexString(),
    slug: b.slug,
    name: b.name,
    specialty: b.specialty,
    bio: b.bio,
    ...photos(b),
    branch: slugOf.get(b.branchId.toHexString()),
  }));
}

export const toBarber = (b: BarberDoc) => ({
  id: b._id.toHexString(),
  branchId: b.branchId.toHexString(),
  ...(b.userId && { userId: b.userId.toHexString() }),
  slug: b.slug,
  name: b.name,
  specialty: b.specialty,
  bio: b.bio,
  ...photos(b),
  hours: b.hours,
  serviceIds: b.serviceIds.map((id) => id.toHexString()),
  active: b.active,
});

export const ownBarberId = async (auth: Auth) =>
  (await forTenant(auth.tenantId).barbers.findOne({ userId: auth.userId }))
    ?._id;
