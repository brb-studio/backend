import type { ObjectId } from "mongodb";
import type {
  AppointmentDoc,
  BarberDoc,
  BranchDoc,
} from "../../src/db/collections";
import { dueAtCounter } from "../../src/features/booking/counter";
import { resolveCommission } from "../../src/features/platform/commission";
import { localDate } from "../../src/shared/time";
import type { Booking } from "./agenda";
import { between, chance, MINUTE, rngFor, weighted } from "./ids";

const METHODS: [NonNullable<AppointmentDoc["counter"]>["method"], number][] = [
  ["card", 0.55],
  ["cash", 0.3],
  ["transfer", 0.15],
];
/** Branches that show "visits still to be charged" today (exactly one each). */
export const UNRECORDED_TODAY = ["polanco", "providencia"];
const UNRECORDED_SHARE = 0.02;

/**
 * Closes every completed visit the way `closeAppointment` does: the commission frozen with
 * `resolveCommission` (only for barbers with a rate) and the counter payment for what was due
 * (`dueAtCounter`), received by the barber or the branch manager a few minutes after the end.
 * Today, per branch, the visit that ended last stays open (confirmed: the payment buttons show), and
 * Polanco and Providencia keep one completed visit without a counter payment.
 */
export function closeVisits(
  bookings: Booking[],
  ctx: {
    now: Date;
    branches: BranchDoc[];
    barbers: BarberDoc[];
    managers: Map<string, ObjectId>;
  },
) {
  const { now } = ctx;
  const barberOf = new Map(ctx.barbers.map((b) => [b._id.toHexString(), b]));
  const branchOf = new Map(ctx.branches.map((b) => [b._id.toHexString(), b]));
  const open = new Set<AppointmentDoc>();
  const unrecorded = new Set<AppointmentDoc>();
  for (const branch of ctx.branches) {
    const today = localDate(now, branch.timeZone);
    const done = bookings
      .map((b) => b.doc)
      .filter(
        (d) =>
          d.branchId.equals(branch._id) &&
          d.status === "completed" &&
          localDate(d.startAt, d.timeZone) === today,
      )
      .sort((a, b) => b.endAt.getTime() - a.endAt.getTime());
    const [last, next] = done;
    if (last) open.add(last);
    if (next && UNRECORDED_TODAY.includes(branch.slug)) unrecorded.add(next);
  }

  for (const { doc } of bookings) {
    if (open.has(doc)) {
      doc.status = "confirmed";
      doc.updatedAt = doc.createdAt;
      continue;
    }
    if (doc.status !== "completed") continue;
    const barber = barberOf.get(doc.barberId.toHexString());
    const commission = resolveCommission(doc, barber?.commissionBps);
    if (commission)
      doc.commission = {
        bps: commission.bps,
        amountMinor: commission.amountMinor,
      };
    const rng = rngFor(`counter:${doc._id.toHexString()}`);
    const branch = branchOf.get(doc.branchId.toHexString());
    const isToday =
      branch &&
      localDate(doc.startAt, doc.timeZone) === localDate(now, branch.timeZone);
    if (unrecorded.has(doc) || (!isToday && chance(rng, UNRECORDED_SHARE)))
      continue;
    const due = dueAtCounter(doc);
    if (due <= 0) continue;
    const manager = branch && ctx.managers.get(branch.slug);
    const receivedBy =
      manager && (chance(rng, 0.15) || !barber?.userId)
        ? manager
        : barber?.userId;
    if (!receivedBy) continue;
    const at = new Date(
      Math.min(
        doc.endAt.getTime() + between(rng, 2, 15) * MINUTE,
        now.getTime(),
      ),
    );
    doc.counter = {
      method: weighted(rng, METHODS),
      amountMinor: due,
      receivedBy,
      at,
    };
    doc.updatedAt = at;
  }
}
