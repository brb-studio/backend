import { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  type BranchDoc,
  forTenant,
  type ProductOrderDoc,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { mapBy } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { localDate } from "../../shared/time";
import { visibleBranchIds } from "../auth/policy";
import { dueAtCounter } from "../booking/counter";
import { inMinor, type Movement, productMethod, summarize } from "./rules";

const DAY = 864e5;
const LATE_DAYS = 7;
const hex = (id: ObjectId) => id.toHexString();

type Cut = Pick<
  AppointmentDoc,
  | "_id"
  | "customerId"
  | "startAt"
  | "timeZone"
  | "totalMinor"
  | "payment"
  | "counter"
>;
type Sale = Pick<
  ProductOrderDoc,
  "_id" | "branchId" | "customerId" | "totalMinor" | "payment"
>;

export async function cashDay(
  tenant: Pick<TenantDoc, "_id" | "currency">,
  auth: Auth,
  date: string,
  branchId?: ObjectId,
) {
  const visible = visibleBranchIds(auth);
  if (branchId && visible && !visible.some((id) => id.equals(branchId))) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  const branchIds = branchId ? [branchId] : visible;
  const inBranches = branchIds ? { branchId: { $in: branchIds } } : {};
  const t = forTenant(tenant._id);
  const start = Date.parse(`${date}T00:00:00Z`);
  const end = new Date(start + 2 * DAY);
  const movements: Movement[] = [];
  let unrecorded = 0;

  const cuts = t.appointments
    .find({
      ...inBranches,
      status: "completed",
      startAt: { $gte: new Date(start - LATE_DAYS * DAY), $lt: end },
    })
    .project<Cut>({
      customerId: 1,
      startAt: 1,
      timeZone: 1,
      totalMinor: 1,
      payment: 1,
      counter: 1,
    });
  for await (const a of cuts) {
    if (a.counter) {
      if (localDate(a.counter.at, a.timeZone) !== date) continue;
      movements.push({
        kind: "cut",
        method: a.counter.method,
        amountMinor: a.counter.amountMinor,
        receivedBy: hex(a.counter.receivedBy),
        customerId: hex(a.customerId),
        at: a.counter.at,
        timeZone: a.timeZone,
      });
    } else if (
      localDate(a.startAt, a.timeZone) === date &&
      dueAtCounter(a) > 0
    ) {
      unrecorded++;
    }
  }

  const zones = await mapBy(
    t.branches
      .find(branchIds ? { _id: { $in: branchIds } } : {})
      .project<Pick<BranchDoc, "_id" | "timeZone">>({ timeZone: 1 }),
    (b) => hex(b._id),
    (b) => b.timeZone,
  );
  const sales = t.productOrders
    .find({
      ...inBranches,
      status: "delivered",
      "payment.at": { $gte: new Date(start - DAY), $lt: end },
    })
    .project<Sale>({ branchId: 1, customerId: 1, totalMinor: 1, payment: 1 });
  for await (const o of sales) {
    const zone = zones.get(hex(o.branchId)) ?? "UTC";
    if (!o.payment || localDate(o.payment.at, zone) !== date) continue;
    movements.push({
      kind: "product",
      method: productMethod(o.payment.method),
      amountMinor: o.totalMinor,
      receivedBy: hex(o.payment.receivedBy),
      customerId: hex(o.customerId),
      at: o.payment.at,
      timeZone: zone,
    });
  }
  movements.sort((a, b) => a.at.getTime() - b.at.getTime());

  const ids = [
    ...new Set(movements.flatMap((m) => [m.receivedBy, m.customerId])),
  ].map((id) => new ObjectId(id));
  const names = await mapBy(
    t.users
      .find({ _id: { $in: ids } })
      .project<Pick<UserDoc, "_id" | "name">>({ name: 1 }),
    (u) => hex(u._id),
    (u) => u.name,
  );
  const { totals, people } = summarize(movements);
  return {
    currency: tenant.currency,
    date,
    totals: inMinor(totals),
    people: [...people].map(([id, sums]) => ({
      id,
      name: names.get(id) ?? "",
      ...inMinor(sums),
    })),
    movements: movements.map((m) => ({
      kind: m.kind,
      method: m.method,
      amountMinor: m.amountMinor,
      at: m.at,
      timeZone: m.timeZone,
      receivedBy: names.get(m.receivedBy) ?? "",
      customer: names.get(m.customerId) ?? "",
    })),
    unrecorded,
  };
}
