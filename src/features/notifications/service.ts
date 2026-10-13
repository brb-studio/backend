import { type ClientSession, ObjectId, type WithId } from "mongodb";
import { config } from "../../config";
import {
  type AppointmentDoc,
  type BarberDoc,
  type BranchDoc,
  forTenant,
  type Locale,
  type NotificationDoc,
  platform,
  type TenantDb,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import type { Auth } from "../../shared/http";
import { sendMail } from "../../shared/mail";
import { instantToLocal } from "../../shared/time";
import {
  type PushTarget,
  sendPush,
  type VapidKeys,
} from "../../shared/web-push";

export const summaryOf = (
  appointment: Pick<AppointmentDoc, "startAt" | "timeZone" | "items">,
  branch: Pick<BranchDoc, "name">,
  customerName: string,
  barberName?: string,
): NotificationDoc["summary"] => ({
  start: instantToLocal(appointment.startAt, appointment.timeZone),
  timeZone: appointment.timeZone,
  customerName,
  ...(barberName && { barberName }),
  items: appointment.items.map((item) => item.name),
  branchName: branch.name,
});

export async function notifyBarber(
  t: TenantDb,
  event: {
    type: NotificationDoc["type"];
    appointment: AppointmentDoc;
    barber: BarberDoc;
    branch: BranchDoc;
    customerName: string;
    by?: ObjectId;
  },
  session: ClientSession,
) {
  const { appointment, barber } = event;
  if (!barber.userId || event.by?.equals(barber.userId)) return undefined;
  const notification: NotificationDoc = {
    _id: new ObjectId(),
    tenantId: appointment.tenantId,
    userId: barber.userId,
    type: event.type,
    appointmentId: appointment._id,
    summary: summaryOf(appointment, event.branch, event.customerName),
    createdAt: new Date(),
  };
  await t.notifications.insertOne(notification, { session });
  return notification;
}

/**
 * The customer hears about changes made by someone else (staff, or the payment provider's webhook).
 * Guests have no session to push to, and nobody needs a notice about what they just did themselves.
 */
export async function notifyCustomer(
  t: TenantDb,
  type: Extract<NotificationDoc["type"], `customer.${string}`>,
  appointment: AppointmentDoc,
  session: ClientSession,
  by?: ObjectId,
) {
  if (by?.equals(appointment.customerId)) return undefined;
  const customer = await t.users.findOne(
    { _id: appointment.customerId },
    { session, projection: { name: 1, guest: 1 } },
  );
  if (!customer || customer.guest) return undefined;
  const [barber, branch] = await Promise.all([
    t.barbers.findOne(
      { _id: appointment.barberId },
      { session, projection: { name: 1 } },
    ),
    t.branches.findOne(
      { _id: appointment.branchId },
      { session, projection: { name: 1 } },
    ),
  ]);
  if (!branch) return undefined;
  const notification: NotificationDoc = {
    _id: new ObjectId(),
    tenantId: appointment.tenantId,
    userId: customer._id,
    type,
    appointmentId: appointment._id,
    summary: summaryOf(appointment, branch, customer.name, barber?.name),
    createdAt: new Date(),
  };
  await t.notifications.insertOne(notification, { session });
  return notification;
}

/** Owners and admins hear about chargebacks and about SPEI transfers waiting for their confirmation. */
export async function notifyOwners(
  t: TenantDb,
  event: {
    type: NotificationDoc["type"];
    appointment: AppointmentDoc;
    branch: Pick<BranchDoc, "name">;
    customerName: string;
  },
  session: ClientSession,
) {
  const { appointment } = event;
  const owners = await collect(
    t.users
      .find(
        { role: { $in: ["owner", "admin"] }, active: true },
        { session, limit: 50 },
      )
      .project<{ _id: ObjectId }>({ _id: 1 }),
  );
  const notes: NotificationDoc[] = owners.map(({ _id }) => ({
    _id: new ObjectId(),
    tenantId: appointment.tenantId,
    userId: _id,
    type: event.type,
    appointmentId: appointment._id,
    summary: summaryOf(appointment, event.branch, event.customerName),
    createdAt: new Date(),
  }));
  for (const note of notes) {
    await t.notifications.insertOne(note, { session });
  }
  return notes;
}

type PushTenant = WithId<Pick<TenantDoc, "defaultLocale" | "name">>;
type MailTenant = PushTenant & Pick<TenantDoc, "slug" | "customDomain">;

/** Push goes out after the commit; a failing push service never undoes a booking or a payment. */
export function pushAfterCommit(
  tenant: MailTenant,
  notes: (NotificationDoc | undefined)[],
) {
  const list = notes.filter((n): n is NotificationDoc => n !== undefined);
  Promise.all([deliverPush(tenant, list), deliverEmail(tenant, list)]).catch(
    (err: unknown) =>
      console.error(
        JSON.stringify({
          level: "error",
          event: "push_failed",
          message: String(err),
        }),
      ),
  );
}

/** The same notice by email, so people who never installed the app or muted the phone still hear about it. */
export async function deliverEmail(
  tenant: MailTenant,
  list: NotificationDoc[],
) {
  if (list.length === 0) return;
  const recipients = await collect(
    forTenant(tenant._id)
      .users.find({ _id: { $in: list.map((n) => n.userId) }, active: true })
      .project<WithId<Pick<UserDoc, "email">>>({ email: 1 }),
  );
  const host =
    tenant.customDomain ?? `${tenant.slug}.${config.PLATFORM_DOMAIN}`;
  for (const note of list) {
    const to = recipients.find((u) => u._id.equals(note.userId))?.email;
    if (!to) continue;
    const message = pushMessage(note, tenant.defaultLocale, tenant.name);
    await sendMail({
      to,
      subject: message.title,
      text: `${message.body}\n\n${host}${message.url}`,
    });
  }
}

const TITLES: Record<Locale, Record<NotificationDoc["type"], string>> = {
  es: {
    "appointment.booked": "Nueva cita",
    "appointment.cancelled": "Cita cancelada",
    "appointment.rescheduled": "Cita reprogramada",
    "payment.disputed": "Pago en disputa",
    "payment.transfer_requested": "Transferencia por confirmar",
    "customer.booked": "Cita confirmada",
    "customer.cancelled": "Tu cita fue cancelada",
    "customer.rescheduled": "Tu cita fue reprogramada",
    "customer.paid": "Pago recibido",
    "customer.payment_rejected": "Pago rechazado",
    "customer.reminder": "Recordatorio de tu cita",
  },
  en: {
    "appointment.booked": "New appointment",
    "appointment.cancelled": "Appointment cancelled",
    "appointment.rescheduled": "Appointment rescheduled",
    "payment.disputed": "Payment disputed",
    "payment.transfer_requested": "Transfer to confirm",
    "customer.booked": "Appointment confirmed",
    "customer.cancelled": "Your appointment was cancelled",
    "customer.rescheduled": "Your appointment was rescheduled",
    "customer.paid": "Payment received",
    "customer.payment_rejected": "Payment rejected",
    "customer.reminder": "Reminder: your appointment",
  },
};

export function pushMessage(
  n: NotificationDoc,
  locale: Locale,
  tenantName: string,
) {
  const when = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${n.summary.start}:00Z`));
  const items = n.summary.items
    .map((name) => name[locale] ?? name.es ?? name.en ?? "")
    .join(" + ");
  const forCustomer = n.type.startsWith("customer.");
  const who = forCustomer ? n.summary.barberName : n.summary.customerName;
  return {
    // The barbershop's name tells people with several accounts which one is talking.
    title: `${TITLES[locale][n.type]} · ${tenantName}`,
    body: [who, items, when, n.summary.branchName].filter(Boolean).join(" · "),
    tag: n.appointmentId.toHexString(),
    url: `/${locale}/account`,
  };
}

const vapid: VapidKeys | undefined =
  config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY && config.VAPID_SUBJECT
    ? {
        publicKey: config.VAPID_PUBLIC_KEY,
        privateKey: config.VAPID_PRIVATE_KEY,
        subject: config.VAPID_SUBJECT,
      }
    : undefined;

export const pushPublicKey = () => vapid?.publicKey;

const PUSH_CONCURRENCY = 20;

export type PushMessage = ReturnType<typeof pushMessage>;

export const deliverPush = (tenant: PushTenant, list: NotificationDoc[]) =>
  deliverMessages(
    tenant,
    list.map((n) => ({
      userId: n.userId,
      message: pushMessage(n, tenant.defaultLocale, tenant.name),
    })),
  );

export async function deliverMessages(
  tenant: PushTenant,
  items: { userId: ObjectId; message: PushMessage }[],
) {
  if (!vapid || items.length === 0) return;
  const keys = vapid;
  const t = forTenant(tenant._id);
  const devices = await collect(
    t.pushSubscriptions.find({ userId: { $in: items.map((i) => i.userId) } }),
  );
  const jobs = items.flatMap(({ userId, message }) =>
    devices
      .filter((d) => d.userId.equals(userId))
      .map((device) => ({ device, message })),
  );
  for (let i = 0; i < jobs.length; i += PUSH_CONCURRENCY) {
    const chunk = jobs.slice(i, i + PUSH_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map(async ({ device, message }) => {
        const status = await sendPush(device, message, keys);
        if (status === 404 || status === 410) {
          await t.pushSubscriptions.deleteOne({ _id: device._id });
        } else if (status >= 400) {
          throw new Error(`push service answered ${status}`);
        }
      }),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error(
          JSON.stringify({
            level: "error",
            event: "push_failed",
            message: String(result.reason),
          }),
        );
      }
    }
  }
}

export async function subscribePush(auth: Auth, target: PushTarget) {
  const now = new Date();
  await platform.pushSubscriptions.updateOne(
    { endpoint: target.endpoint },
    {
      $set: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        keys: target.keys,
        updatedAt: now,
      },
      $setOnInsert: { _id: new ObjectId(), createdAt: now },
    },
    { upsert: true },
  );
}

export async function unsubscribePush(auth: Auth, endpoint: string) {
  await forTenant(auth.tenantId).pushSubscriptions.deleteOne({
    userId: auth.userId,
    endpoint,
  });
}

export async function listNotifications(
  auth: Auth,
  { page, pageSize }: { page: number; pageSize: number },
) {
  const t = forTenant(auth.tenantId);
  const mine = { userId: auth.userId };
  const [items, unread, total] = await Promise.all([
    collect(
      t.notifications
        .find(mine)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize),
      toNotification,
    ),
    t.notifications.countDocuments({ ...mine, readAt: { $exists: false } }),
    t.notifications.countDocuments(mine),
  ]);
  return { unread, total, page, pageSize, items };
}

export async function markRead(auth: Auth, ids?: ObjectId[]) {
  await forTenant(auth.tenantId).notifications.updateMany(
    {
      userId: auth.userId,
      readAt: { $exists: false },
      ...(ids && { _id: { $in: ids } }),
    },
    { $set: { readAt: new Date() } },
  );
}

export const toNotification = (n: NotificationDoc) => ({
  id: n._id.toHexString(),
  type: n.type,
  appointmentId: n.appointmentId.toHexString(),
  summary: n.summary,
  read: !!n.readAt,
  createdAt: n.createdAt,
});
