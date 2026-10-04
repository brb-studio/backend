import { type ClientSession, ObjectId } from "mongodb";
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
} from "../../db/scoped";
import type { Auth } from "../../shared/http";
import { instantToLocal } from "../../shared/time";
import {
  type PushTarget,
  sendPush,
  type VapidKeys,
} from "../../shared/web-push";

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
    summary: {
      start: instantToLocal(appointment.startAt, appointment.timeZone),
      timeZone: appointment.timeZone,
      customerName: event.customerName,
      items: appointment.items.map((item) => item.name),
      branchName: event.branch.name,
    },
    createdAt: new Date(),
  };
  await t.notifications.insertOne(notification, { session });
  return notification;
}

const TITLES: Record<Locale, Record<NotificationDoc["type"], string>> = {
  es: {
    "appointment.booked": "Nueva cita",
    "appointment.cancelled": "Cita cancelada",
    "appointment.rescheduled": "Cita reprogramada",
  },
  en: {
    "appointment.booked": "New appointment",
    "appointment.cancelled": "Appointment cancelled",
    "appointment.rescheduled": "Appointment rescheduled",
  },
};

export function pushMessage(n: NotificationDoc, locale: Locale) {
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
  return {
    title: TITLES[locale][n.type],
    body: [n.summary.customerName, items, when, n.summary.branchName]
      .filter(Boolean)
      .join(" · "),
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

export async function deliverPush(
  tenant: Pick<TenantDoc, "_id" | "defaultLocale">,
  list: NotificationDoc[],
) {
  if (!vapid || list.length === 0) return;
  const keys = vapid;
  const t = forTenant(tenant._id);
  const devices = await t.pushSubscriptions
    .find({ userId: { $in: list.map((n) => n.userId) } })
    .toArray();
  const jobs = list.flatMap((n) =>
    devices
      .filter((d) => d.userId.equals(n.userId))
      .map((device) => ({
        device,
        message: pushMessage(n, tenant.defaultLocale),
      })),
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

export async function listNotifications(auth: Auth) {
  const t = forTenant(auth.tenantId);
  const [items, unread] = await Promise.all([
    t.notifications
      .find({ userId: auth.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray(),
    t.notifications.countDocuments({
      userId: auth.userId,
      readAt: { $exists: false },
    }),
  ]);
  return { unread, items: items.map(toNotification) };
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
