import { type ClientSession, ObjectId } from "mongodb";
import type * as z from "zod";
import {
  forTenant,
  type PromotionDoc,
  type PromotionSnapshot,
  runAll,
  type TenantDb,
} from "../../db/scoped";
import { AppError, type Auth, isDuplicate } from "../../shared/http";
import { evaluate, type Rejection } from "./rules";
import type { promotionCreate, promotionUpdate } from "./schemas";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

async function assertExist(
  count: (ids: ObjectId[]) => Promise<number>,
  ids: ObjectId[],
  path: string,
) {
  const unique = [...new Map(ids.map((id) => [id.toHexString(), id])).values()];
  if (unique.length > 0 && (await count(unique)) !== unique.length) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path, message: "unknown id" },
    ]);
  }
  return unique;
}

async function checkedRefs(
  t: TenantDb,
  input: {
    branchIds?: ObjectId[];
    serviceIds?: ObjectId[];
    packageIds?: ObjectId[];
  },
) {
  const [branchIds, serviceIds, packageIds] = await Promise.all([
    input.branchIds &&
      assertExist(
        (ids) => t.branches.countDocuments({ _id: { $in: ids } }),
        input.branchIds,
        "branchIds",
      ),
    input.serviceIds &&
      assertExist(
        (ids) => t.services.countDocuments({ _id: { $in: ids } }),
        input.serviceIds,
        "serviceIds",
      ),
    input.packageIds &&
      assertExist(
        (ids) => t.packages.countDocuments({ _id: { $in: ids } }),
        input.packageIds,
        "packageIds",
      ),
  ]);
  return {
    ...(branchIds && { branchIds }),
    ...(serviceIds && { serviceIds }),
    ...(packageIds && { packageIds }),
  };
}

const codeTaken = (err: unknown) =>
  isDuplicate(err)
    ? new AppError(409, "CODE_TAKEN", "Another promotion uses this code")
    : err;

export const listPromotions = (auth: Auth) =>
  forTenant(auth.tenantId).promotions.find().sort({ createdAt: -1 }).toArray();

export async function getPromotion(auth: Auth, id: ObjectId) {
  const promo = await forTenant(auth.tenantId).promotions.findOne({ _id: id });
  if (!promo) throw notFound();
  return promo;
}

export async function createPromotion(
  auth: Auth,
  input: z.output<typeof promotionCreate>,
) {
  const t = forTenant(auth.tenantId);
  const now = new Date();
  const promo: PromotionDoc = {
    _id: new ObjectId(),
    tenantId: auth.tenantId,
    ...input,
    ...(await checkedRefs(t, input)),
    redemptions: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  await t.promotions.insertOne(promo).catch((err) => {
    throw codeTaken(err);
  });
  return promo;
}

export async function updatePromotion(
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof promotionUpdate>,
) {
  const t = forTenant(auth.tenantId);
  const current = await getPromotion(auth, id);
  const merged = { ...current, ...input };
  if (merged.type === "percent" && merged.value > 100) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "value", message: "a percentage is 1–100" },
    ]);
  }
  if (merged.startsAt && merged.endsAt && merged.startsAt >= merged.endsAt) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "endsAt", message: "must be after startsAt" },
    ]);
  }
  const updated = await t.promotions
    .findOneAndUpdate(
      { _id: id },
      {
        $set: {
          ...input,
          ...(await checkedRefs(t, input)),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    )
    .catch((err) => {
      throw codeTaken(err);
    });
  if (!updated) throw notFound();
  return updated;
}

export type Price = {
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  promotion?: PromotionDoc;
  promotionSnapshot?: PromotionSnapshot;
  rejected?: Rejection | "unknown_code";
};

export async function priceFor(
  t: TenantDb,
  input: {
    branchId: ObjectId;
    item: { kind: "service" | "package"; id: ObjectId };
    subtotalMinor: number;
    customerId?: ObjectId;
    code?: string;
    now: Date;
    session?: ClientSession;
  },
): Promise<Price> {
  const { session } = input;
  const full: Price = {
    subtotalMinor: input.subtotalMinor,
    discountMinor: 0,
    totalMinor: input.subtotalMinor,
  };
  const candidates = input.code
    ? await t.promotions.find({ code: input.code }, { session }).toArray()
    : await t.promotions
        .find({ active: true, code: { $exists: false } }, { session })
        .toArray();
  if (input.code && candidates.length === 0) {
    return { ...full, rejected: "unknown_code" };
  }
  const visits = input.customerId
    ? await t.appointments.countDocuments(
        {
          customerId: input.customerId,
          status: { $in: ["confirmed", "completed"] },
        },
        { session },
      )
    : 0;
  const { customerId } = input;
  const uses = customerId
    ? await runAll(
        candidates.map(
          (promo) => () =>
            t.appointments.countDocuments(
              {
                customerId,
                "promotion.promotionId": promo._id,
                status: { $ne: "cancelled" },
              },
              { session },
            ),
        ),
        session,
      )
    : [];
  let best: { promo: PromotionDoc; amountMinor: number } | undefined;
  let rejected: Rejection | undefined;
  for (const [index, promo] of candidates.entries()) {
    const result = evaluate(promo, {
      now: input.now,
      branchId: input.branchId,
      item: input.item,
      subtotalMinor: input.subtotalMinor,
      customerVisits: visits,
      customerUses: uses[index] ?? 0,
    });
    if (!result.ok) rejected = result.reason;
    else if (!best || result.amountMinor > best.amountMinor) {
      best = { promo, amountMinor: result.amountMinor };
    }
  }
  if (!best) return input.code ? { ...full, rejected } : full;
  return {
    subtotalMinor: input.subtotalMinor,
    discountMinor: best.amountMinor,
    totalMinor: input.subtotalMinor - best.amountMinor,
    promotion: best.promo,
    promotionSnapshot: {
      promotionId: best.promo._id,
      ...(best.promo.code && { code: best.promo.code }),
      name: best.promo.name,
      type: best.promo.type,
      value: best.promo.value,
      amountMinor: best.amountMinor,
    },
  };
}

export async function redeem(
  t: TenantDb,
  promo: PromotionDoc,
  session: ClientSession,
) {
  const counted = await t.promotions.findOneAndUpdate(
    {
      _id: promo._id,
      active: true,
      $or: [
        { maxRedemptions: { $exists: false } },
        { $expr: { $lt: ["$redemptions", "$maxRedemptions"] } },
      ],
    },
    { $inc: { redemptions: 1 } },
    { session },
  );
  if (!counted) {
    throw new AppError(
      409,
      "PROMOTION_UNAVAILABLE",
      "That promotion is no longer available",
    );
  }
}

export async function release(
  t: TenantDb,
  promotionId: ObjectId,
  session: ClientSession,
) {
  await t.promotions.updateOne(
    { _id: promotionId, redemptions: { $gt: 0 } },
    { $inc: { redemptions: -1 } },
    { session },
  );
}

export const toPromotion = (p: PromotionDoc) => ({
  id: p._id.toHexString(),
  name: p.name,
  ...(p.code && { code: p.code }),
  type: p.type,
  value: p.value,
  startsAt: p.startsAt,
  endsAt: p.endsAt,
  branchIds: p.branchIds.map((id) => id.toHexString()),
  serviceIds: p.serviceIds.map((id) => id.toHexString()),
  packageIds: p.packageIds.map((id) => id.toHexString()),
  minSubtotalMinor: p.minSubtotalMinor,
  firstVisitOnly: p.firstVisitOnly,
  maxRedemptions: p.maxRedemptions,
  maxPerCustomer: p.maxPerCustomer,
  redemptions: p.redemptions,
  active: p.active,
});
