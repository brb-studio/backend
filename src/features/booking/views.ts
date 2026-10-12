import type { ObjectId, WithId } from "mongodb";
import type {
  AppointmentDoc,
  BarberDoc,
  BranchDoc,
  CustomerDoc,
  TenantDb,
} from "../../db/scoped";
import { mapBy } from "../../shared/cursor";
import { instantToLocal } from "../../shared/time";
import { customerRefundable } from "../payments/rules";

/** What an appointment view shows of its branch and barber (and the cancel notice customers get). */
type ViewBranch = WithId<Pick<BranchDoc, "slug" | "name" | "booking">>;
type ViewBarber = WithId<Pick<BarberDoc, "slug" | "name">>;

export async function lookups(t: TenantDb, list: AppointmentDoc[]) {
  const ids = (pick: (a: AppointmentDoc) => ObjectId) => [
    ...new Map(list.map((a) => [pick(a).toHexString(), pick(a)])).values(),
  ];
  const [branches, barbers] = await Promise.all([
    mapBy(
      t.branches
        .find({ _id: { $in: ids((a) => a.branchId) } })
        .project<ViewBranch>({ slug: 1, name: 1, booking: 1 }),
      (b) => b._id.toHexString(),
    ),
    mapBy(
      t.barbers
        .find({ _id: { $in: ids((a) => a.barberId) } })
        .project<ViewBarber>({ slug: 1, name: 1 }),
      (b) => b._id.toHexString(),
    ),
  ]);
  return {
    branchOf: (id: ObjectId) => branches.get(id.toHexString()),
    barberOf: (id: ObjectId) => barbers.get(id.toHexString()),
  };
}

function baseView(
  a: AppointmentDoc,
  branch: ViewBranch | undefined,
  barber: ViewBarber | undefined,
) {
  return {
    id: a._id.toHexString(),
    status: a.status,
    startAt: a.startAt,
    endAt: a.endAt,
    timeZone: a.timeZone,
    start: instantToLocal(a.startAt, a.timeZone),
    end: instantToLocal(a.endAt, a.timeZone),
    branch: branch && { slug: branch.slug, name: branch.name },
    barber: barber && { slug: barber.slug, name: barber.name },
    items: a.items.map((item) =>
      item.kind === "service"
        ? {
            kind: item.kind,
            name: item.name,
            durationMin: item.durationMin,
            priceMinor: item.priceMinor,
          }
        : {
            kind: item.kind,
            name: item.name,
            durationMin: item.durationMin,
            priceMinor: item.priceMinor,
            services: item.services.map((s) => ({
              name: s.name,
              durationMin: s.durationMin,
            })),
          },
    ),
    currency: a.currency,
    subtotalMinor: a.subtotalMinor,
    discountMinor: a.discountMinor,
    totalMinor: a.totalMinor,
    payment: a.payment ? ticketOf(a, a.payment) : null,
    ...(a.status === "pending_payment" && {
      paymentDeadline: a.paymentDeadline,
    }),
    ...(a.promotion && {
      promotion: {
        code: a.promotion.code,
        name: a.promotion.name,
        amountMinor: a.promotion.amountMinor,
      },
    }),
    notes: a.notes,
    createdAt: a.createdAt,
  };
}

/** Payment states where the money is with the barbershop (minus refunds). */
const COLLECTED = new Set(["paid", "disputed", "refunded"]);

/** The "ticket": how much was paid, how, and what is left to pay at the barbershop. */
function ticketOf(
  a: AppointmentDoc,
  payment: NonNullable<AppointmentDoc["payment"]>,
) {
  const paidMinor = COLLECTED.has(payment.status)
    ? payment.amountMinor - (payment.refundedMinor ?? 0)
    : 0;
  return {
    provider: payment.provider,
    method: payment.method ?? (payment.provider === "spei" ? "spei" : "card"),
    kind: payment.kind ?? "full",
    status: payment.status,
    amountMinor: payment.amountMinor,
    paidMinor,
    refundedMinor: payment.refundedMinor ?? 0,
    balanceMinor: Math.max(0, a.totalMinor - paidMinor),
    // Online payments: what the customer would get back cancelling in time (Stripe's fee stays).
    ...(payment.provider === "stripe" &&
      payment.paymentId && {
        refundableMinor: customerRefundable(
          paidMinor,
          (payment.applicationFeeMinor ?? 0) - (payment.debtMinor ?? 0),
        ),
      }),
    ...(payment.cardBrand && { cardBrand: payment.cardBrand }),
    ...(payment.cardLast4 && { cardLast4: payment.cardLast4 }),
    paidAt: payment.paidAt ?? null,
  };
}

export function customerView(
  a: AppointmentDoc,
  branch: ViewBranch | undefined,
  barber: ViewBarber | undefined,
  now: number,
) {
  const notice = (branch?.booking.cancelNoticeMin ?? 0) * 60_000;
  return {
    ...baseView(a, branch, barber),
    cancellable:
      a.status === "confirmed" && now <= a.startAt.getTime() - notice,
  };
}

export async function staffViews(t: TenantDb, list: AppointmentDoc[]) {
  const [{ branchOf, barberOf }, personOf] = await Promise.all([
    lookups(t, list),
    mapBy(
      t.customers
        .find({ _id: { $in: list.map((a) => a.customerId) } })
        .project<WithId<Pick<CustomerDoc, "name" | "phone" | "email">>>({
          name: 1,
          phone: 1,
          email: 1,
        }),
      (c) => c._id.toHexString(),
    ),
  ]);
  return list.map((a) => {
    const customer = personOf.get(a.customerId.toHexString());
    return {
      ...baseView(a, branchOf(a.branchId), barberOf(a.barberId)),
      branchId: a.branchId.toHexString(),
      barberId: a.barberId.toHexString(),
      customer: customer && {
        id: customer._id.toHexString(),
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
      },
      source: a.source,
      cancelledAt: a.cancelledAt,
      cancelReason: a.cancelReason,
    };
  });
}
