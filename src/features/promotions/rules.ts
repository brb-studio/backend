import type { ObjectId } from "mongodb";
import type { PromotionDoc } from "../../db/scoped";

export type PromotionContext = {
  now: Date;
  branchId: ObjectId;
  item: { kind: "service" | "package"; id: ObjectId };
  subtotalMinor: number;
  customerVisits: number;
  customerUses: number;
};

export type Rejection =
  | "inactive"
  | "not_started"
  | "expired"
  | "branch"
  | "item"
  | "min_subtotal"
  | "first_visit"
  | "customer_limit"
  | "exhausted";

export type Evaluation =
  | { ok: true; amountMinor: number }
  | { ok: false; reason: Rejection };

const has = (ids: ObjectId[], id: ObjectId) => ids.some((x) => x.equals(id));
const no = (reason: Rejection): Evaluation => ({ ok: false, reason });

export function evaluate(
  promo: Omit<PromotionDoc, "tenantId" | "createdAt" | "updatedAt">,
  ctx: PromotionContext,
): Evaluation {
  if (!promo.active) return no("inactive");
  if (promo.startsAt && ctx.now < promo.startsAt) return no("not_started");
  if (promo.endsAt && ctx.now >= promo.endsAt) return no("expired");
  if (promo.branchIds.length > 0 && !has(promo.branchIds, ctx.branchId)) {
    return no("branch");
  }
  const restricted = promo.serviceIds.length + promo.packageIds.length > 0;
  const allowed =
    ctx.item.kind === "service"
      ? has(promo.serviceIds, ctx.item.id)
      : has(promo.packageIds, ctx.item.id);
  if (restricted && !allowed) return no("item");
  if (promo.minSubtotalMinor && ctx.subtotalMinor < promo.minSubtotalMinor) {
    return no("min_subtotal");
  }
  if (promo.firstVisitOnly && ctx.customerVisits > 0) return no("first_visit");
  if (promo.maxPerCustomer && ctx.customerUses >= promo.maxPerCustomer) {
    return no("customer_limit");
  }
  if (
    promo.maxRedemptions !== undefined &&
    promo.redemptions >= promo.maxRedemptions
  ) {
    return no("exhausted");
  }
  const amountMinor =
    promo.type === "percent"
      ? Math.floor((ctx.subtotalMinor * promo.value) / 100)
      : Math.min(promo.value, ctx.subtotalMinor);
  return { ok: true, amountMinor };
}
