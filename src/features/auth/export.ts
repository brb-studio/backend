import { forTenant } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import type { Auth } from "../../shared/http";
import { getUser } from "./service";

/**
 * Everything this barbershop holds about a customer, for the ARCO right of access. Only this shop's records
 * (the tenant scope), and no secrets: no password hash, sessions, device push keys or Stripe ids.
 */
export async function exportMyData(auth: Auth, shop: string, now = new Date()) {
  const t = forTenant(auth.tenantId);
  const user = await getUser(auth);
  const customerId = auth.userId;

  const appointments = await collect(
    t.appointments.find({ customerId }).sort({ startAt: 1 }),
    (a) => ({
      startAt: a.startAt,
      timeZone: a.timeZone,
      status: a.status,
      currency: a.currency,
      items: a.items.map((item) => ({
        name: item.name,
        durationMin: item.durationMin,
        priceMinor: item.priceMinor,
      })),
      subtotalMinor: a.subtotalMinor,
      discountMinor: a.discountMinor,
      totalMinor: a.totalMinor,
      payment: a.payment && {
        method: a.payment.method,
        kind: a.payment.kind,
        status: a.payment.status,
        amountMinor: a.payment.amountMinor,
        refundedMinor: a.payment.refundedMinor ?? 0,
        paidAt: a.payment.paidAt,
      },
      counter: a.counter && {
        method: a.counter.method,
        amountMinor: a.counter.amountMinor,
        at: a.counter.at,
      },
      cancelledAt: a.cancelledAt,
      cancelReason: a.cancelReason,
    }),
  );

  const notifications = await collect(
    t.notifications.find({ userId: user._id }).sort({ createdAt: 1 }),
    (n) => ({ type: n.type, createdAt: n.createdAt, summary: n.summary }),
  );

  const waitlist = await collect(
    t.waitlist.find({ customerId }).sort({ createdAt: 1 }),
    (w) => ({
      item: { kind: w.item.kind, name: w.item.name },
      date: w.date,
      from: w.from,
      to: w.to,
      status: w.status,
      createdAt: w.createdAt,
    }),
  );

  const productOrders = await collect(
    t.productOrders.find({ customerId }).sort({ createdAt: 1 }),
    (o) => ({
      status: o.status,
      items: o.items.map((item) => ({
        name: item.name,
        priceMinor: item.priceMinor,
        quantity: item.quantity,
      })),
      currency: o.currency,
      totalMinor: o.totalMinor,
      payment: o.payment && { method: o.payment.method, at: o.payment.at },
      createdAt: o.createdAt,
      closedAt: o.closedAt,
    }),
  );

  return {
    exportedAt: now,
    shop,
    profile: {
      name: user.name,
      email: user.email,
      phone: user.phone,
      createdAt: user.createdAt,
      emailVerifiedAt: user.emailVerifiedAt,
      termsAcceptedAt: user.termsAcceptedAt,
    },
    appointments,
    notifications,
    waitlist,
    productOrders,
  };
}
