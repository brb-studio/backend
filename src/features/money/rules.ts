import { ObjectId } from "mongodb";
import type {
  AppointmentDoc,
  LedgerEntryDoc,
  LedgerMethod,
  Localized,
  PaymentMethod,
  ProductOrderDoc,
} from "../../db/scoped";
import { localDate } from "../../shared/time";

export type NewEntry = Omit<LedgerEntryDoc, "tenantId">;
export type GroupBy = "day" | "week" | "month";

type Visit = Pick<
  AppointmentDoc,
  "_id" | "branchId" | "customerId" | "timeZone" | "currency" | "items"
>;
type Order = Pick<
  ProductOrderDoc,
  "_id" | "branchId" | "customerId" | "currency" | "items" | "totalMinor"
>;

const textOf = (name: Localized) => Object.values(name).find(Boolean) ?? "";

export const visitConcept = (items: Visit["items"]) =>
  items.map((i) => textOf(i.name)).join(" + ");

export const orderConcept = (items: Order["items"]) =>
  items
    .map((i) => `${textOf(i.name)}${i.quantity > 1 ? ` ×${i.quantity}` : ""}`)
    .join(" + ");

export const methodOf = (method: PaymentMethod | "cash"): LedgerMethod =>
  method === "cash" ? "cash" : method === "card" ? "card" : "transfer";

function base<E extends Pick<NewEntry, "branchId" | "currency" | "concept">>(
  source: string,
  at: Date,
  timeZone: string,
  extra: E,
) {
  return {
    _id: new ObjectId(),
    source,
    at,
    localDate: localDate(at, timeZone),
    createdAt: new Date(),
    ...extra,
  };
}

const fromVisit = (v: Visit) => ({
  branchId: v.branchId,
  currency: v.currency,
  concept: visitConcept(v.items),
  customerId: v.customerId,
  appointmentId: v._id,
});

export function counterEntry(
  visit: Visit,
  counter: NonNullable<AppointmentDoc["counter"]>,
): NewEntry {
  return {
    ...base(
      `counter:${visit._id.toHexString()}`,
      counter.at,
      visit.timeZone,
      fromVisit(visit),
    ),
    direction: "in",
    type: "service_payment",
    method: counter.method,
    channel: "counter",
    amountMinor: counter.amountMinor,
    recordedBy: counter.receivedBy,
  };
}

type Paid = {
  _id: ObjectId;
  method: PaymentMethod;
  amountMinor: number;
  reference?: string;
};

export function paymentEntry(
  visit: Visit,
  payment: Paid,
  at: Date,
  recordedBy?: ObjectId,
): NewEntry {
  return {
    ...base(
      `payment:${payment._id.toHexString()}`,
      at,
      visit.timeZone,
      fromVisit(visit),
    ),
    direction: "in",
    type: "service_payment",
    method: methodOf(payment.method),
    channel: payment.method === "spei" ? "spei" : "online",
    amountMinor: payment.amountMinor,
    paymentId: payment._id,
    ...(payment.reference && { reference: payment.reference }),
    ...(recordedBy && { recordedBy }),
  };
}

export function onlineEntry(
  visit: Visit,
  payment: Paid,
  at: Date,
  type: "online_fee" | "refund" | "chargeback",
  amountMinor: number,
  source: string,
  extra: Pick<NewEntry, "approximate" | "recordedBy" | "reference"> = {},
): NewEntry {
  return {
    ...base(source, at, visit.timeZone, fromVisit(visit)),
    direction: "out",
    type,
    method: methodOf(payment.method),
    channel: payment.method === "spei" ? "spei" : "online",
    amountMinor,
    paymentId: payment._id,
    ...extra,
  };
}

export function saleEntry(
  order: Order,
  payment: NonNullable<ProductOrderDoc["payment"]>,
  timeZone: string,
): NewEntry {
  const extra = {
    branchId: order.branchId,
    currency: order.currency,
    concept: orderConcept(order.items),
  };
  return {
    ...base(`product:${order._id.toHexString()}`, payment.at, timeZone, extra),
    direction: "in",
    type: "product_sale",
    method: methodOf(payment.method === "spei" ? "spei" : "cash"),
    channel: "counter",
    amountMinor: order.totalMinor,
    customerId: order.customerId,
    productOrderId: order._id,
    recordedBy: payment.receivedBy,
  };
}

export function payoutEntry(
  payout: {
    _id: ObjectId;
    currency: string;
    amountMinor: number;
    paidAt: Date;
    createdBy: ObjectId;
    reference?: string;
  },
  barber: { branchId: ObjectId; name: string },
  timeZone: string,
): NewEntry | undefined {
  if (payout.amountMinor < 1) return undefined;
  const extra = {
    branchId: barber.branchId,
    currency: payout.currency,
    concept: barber.name,
  };
  return {
    ...base(
      `payout:${payout._id.toHexString()}`,
      payout.paidAt,
      timeZone,
      extra,
    ),
    direction: "out",
    type: "payout",
    amountMinor: payout.amountMinor,
    payoutId: payout._id,
    recordedBy: payout.createdBy,
    ...(payout.reference && { reference: payout.reference }),
  };
}

const dayMs = (value: string) => Date.parse(`${value}T00:00:00Z`);
const DAY = 864e5;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function periodOf(day: string, groupBy: GroupBy) {
  if (groupBy === "day") return day;
  if (groupBy === "month") return day.slice(0, 7);
  const ms = dayMs(day);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7;
  return iso(ms - weekday * DAY);
}

export function periodsBetween(from: string, to: string, groupBy: GroupBy) {
  const keys = new Set<string>();
  for (let at = dayMs(from); at <= dayMs(to); at += DAY) {
    keys.add(periodOf(iso(at), groupBy));
  }
  return [...keys];
}

export function previousRange(from: string, to: string) {
  const length = dayMs(to) - dayMs(from) + DAY;
  return { from: iso(dayMs(from) - length), to: iso(dayMs(from) - DAY) };
}

type Row = Pick<
  LedgerEntryDoc,
  "localDate" | "direction" | "type" | "method" | "amountMinor"
>;
type Flow = { inMinor: number; outMinor: number };

const flow = (): Flow => ({ inMinor: 0, outMinor: 0 });
const add = (f: Flow, r: Row) => {
  if (r.direction === "in") f.inMinor += r.amountMinor;
  else f.outMinor += r.amountMinor;
};
const withNet = (f: Flow) => ({ ...f, netMinor: f.inMinor - f.outMinor });

export function tally(periods: string[], groupBy: GroupBy) {
  const total = flow();
  const byType = new Map<string, Flow>();
  const byMethod = new Map<string, Flow>();
  const series = new Map(periods.map((p) => [p, flow()]));
  const push = (r: Row) => {
    add(total, r);
    const type = byType.get(r.type) ?? flow();
    add(type, r);
    byType.set(r.type, type);
    if (r.method) {
      const method = byMethod.get(r.method) ?? flow();
      add(method, r);
      byMethod.set(r.method, method);
    }
    const bucket = series.get(periodOf(r.localDate, groupBy));
    if (bucket) add(bucket, r);
  };
  const result = () => ({
    ...withNet(total),
    byType: Object.fromEntries([...byType].map(([k, f]) => [k, withNet(f)])),
    byMethod: Object.fromEntries(
      [...byMethod].map(([k, f]) => [k, withNet(f)]),
    ),
    servicesMinor: byType.get("service_payment")?.inMinor ?? 0,
    productsMinor: byType.get("product_sale")?.inMinor ?? 0,
    series: [...series].map(([period, f]) => ({ period, ...withNet(f) })),
  });
  return { push, result };
}
