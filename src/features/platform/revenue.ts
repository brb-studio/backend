import {
  type AppointmentDoc,
  type BarberDoc,
  type BranchDoc,
  forTenant,
  type ProductOrderDoc,
  type TenantDoc,
} from "../../db/scoped";
import { mapBy } from "../../shared/cursor";
import { localDate } from "../../shared/time";
import { resolveCommission } from "./commission";
import { hex } from "./queries";

const DAY = 864e5;
const dayMs = (value: string) => Date.parse(`${value}T00:00:00Z`);

type Cut = Pick<
  AppointmentDoc,
  | "_id"
  | "barberId"
  | "status"
  | "startAt"
  | "timeZone"
  | "totalMinor"
  | "commission"
>;

type Sale = Pick<ProductOrderDoc, "branchId" | "totalMinor"> & {
  payment?: Pick<NonNullable<ProductOrderDoc["payment"]>, "at">;
};

/**
 * What the barbershop took in over a range of local days: completed cuts plus delivered products,
 * and the barbers' commission on those cuts. Each sale counts on its own day in its branch's zone.
 * ponytail: a single currency, the tenant's, since it is fixed when the shop is created.
 */
export async function revenue(
  tenant: Pick<TenantDoc, "_id" | "currency">,
  from: string,
  to: string,
) {
  const t = forTenant(tenant._id);
  // Coarse UTC window on the index, then the exact local day in JS.
  const near = {
    $gte: new Date(dayMs(from) - DAY),
    $lt: new Date(dayMs(to) + 2 * DAY),
  };
  const days = new Map<string, number>();
  for (let at = dayMs(from); at <= dayMs(to); at += DAY) {
    days.set(new Date(at).toISOString().slice(0, 10), 0);
  }
  const inRange = (day: string, amountMinor: number) => {
    const sum = days.get(day);
    if (sum === undefined) return false;
    days.set(day, sum + amountMinor);
    return true;
  };
  const totals = { servicesMinor: 0, productsMinor: 0, commissionMinor: 0 };
  let cuts = 0;

  const rates = await mapBy(
    t.barbers
      .find({ commissionBps: { $exists: true } })
      .project<Required<Pick<BarberDoc, "_id" | "commissionBps">>>({
        commissionBps: 1,
      }),
    (b) => hex(b._id),
    (b) => b.commissionBps,
  );
  const appointments = t.appointments
    .find({ status: "completed", currency: tenant.currency, startAt: near })
    .project<Cut>({
      barberId: 1,
      status: 1,
      startAt: 1,
      timeZone: 1,
      totalMinor: 1,
      commission: 1,
    });
  for await (const a of appointments) {
    if (!inRange(localDate(a.startAt, a.timeZone), a.totalMinor)) continue;
    cuts++;
    totals.servicesMinor += a.totalMinor;
    totals.commissionMinor +=
      resolveCommission(a, rates.get(hex(a.barberId)))?.amountMinor ?? 0;
  }

  const zones = await mapBy(
    t.branches.find({}).project<Pick<BranchDoc, "_id" | "timeZone">>({
      timeZone: 1,
    }),
    (b) => hex(b._id),
    (b) => b.timeZone,
  );
  // ponytail: rides the tenant+status prefix of `tenant_status_expires`; add a delivered-at index if pickups pile up.
  const orders = t.productOrders
    .find({
      status: "delivered",
      currency: tenant.currency,
      "payment.at": near,
    })
    .project<Sale>({ _id: 0, branchId: 1, totalMinor: 1, "payment.at": 1 });
  for await (const o of orders) {
    const zone = zones.get(hex(o.branchId)) ?? "UTC";
    if (o.payment && inRange(localDate(o.payment.at, zone), o.totalMinor)) {
      totals.productsMinor += o.totalMinor;
    }
  }

  return {
    currency: tenant.currency,
    cuts,
    ...totals,
    days: [...days].map(([date, totalMinor]) => ({ date, totalMinor })),
  };
}
