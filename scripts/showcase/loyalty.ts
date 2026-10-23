import type { PromotionDoc } from "../../src/db/collections";
import { evaluate } from "../../src/features/promotions/rules";
import type { Booking } from "./agenda";
import { PROMO } from "./catalog";
import { chance, pick, rngFor } from "./ids";

const LIVE = new Set(["confirmed", "completed"]);
const hex = (id: { toHexString(): string }) => id.toHexString();

/**
 * Replays the shop's promotions over the agenda in booking order, with the same `evaluate` the booking
 * flow uses: automatic ones (first visit, every 6th visit) pick the best discount, and a few online
 * package bookings carry a code. Visits count confirmed + completed, like `customerVisits`.
 * Returns each promotion's redemptions (bookings that kept it, i.e. not cancelled).
 */
export function applyPromotions(
  bookings: Booking[],
  promotions: PromotionDoc[],
) {
  const visits = new Map<string, number>();
  const uses = new Map<string, number>();
  const redemptions = new Map<string, number>();
  const automatic = promotions.filter((p) => !p.code);
  const coded = promotions.filter(
    (p) => p._id.equals(PROMO.cobre100) || p._id.equals(PROMO.ritual),
  );

  for (const { doc, item } of bookings) {
    const customer = hex(doc.customerId);
    const customerVisits = visits.get(customer) ?? 0;
    const rng = rngFor(`promo:${hex(doc._id)}`);
    const tryCode =
      doc.source === "online" && item.kind === "package" && chance(rng, 0.12);
    const candidates = [
      ...automatic,
      ...(tryCode ? [pick(rng, coded)] : []),
    ].filter((p) => p.createdAt <= doc.createdAt);
    let best: { promo: PromotionDoc; amountMinor: number } | undefined;
    for (const promo of candidates) {
      const key = `${customer}:${hex(promo._id)}`;
      const result = evaluate(
        { ...promo, redemptions: redemptions.get(hex(promo._id)) ?? 0 },
        {
          now: doc.createdAt,
          branchId: doc.branchId,
          item,
          subtotalMinor: doc.subtotalMinor,
          customerVisits,
          customerUses: uses.get(key) ?? 0,
        },
      );
      if (
        result.ok &&
        result.amountMinor > 0 &&
        (!best || result.amountMinor > best.amountMinor)
      ) {
        best = { promo, amountMinor: result.amountMinor };
      }
    }
    if (best) {
      const { promo, amountMinor } = best;
      doc.promotion = {
        promotionId: promo._id,
        ...(promo.code && { code: promo.code }),
        name: promo.name,
        type: promo.type,
        value: promo.value,
        amountMinor,
      };
      doc.discountMinor = amountMinor;
      doc.totalMinor = doc.subtotalMinor - amountMinor;
      if (doc.status !== "cancelled") {
        const key = `${customer}:${hex(promo._id)}`;
        uses.set(key, (uses.get(key) ?? 0) + 1);
        redemptions.set(
          hex(promo._id),
          (redemptions.get(hex(promo._id)) ?? 0) + 1,
        );
      }
    }
    if (LIVE.has(doc.status)) visits.set(customer, customerVisits + 1);
  }
  return redemptions;
}
