import { ObjectId, type WithId } from "mongodb";
import { config } from "../../config";
import { hit } from "../../db/rate-limit";
import {
  type AppointmentDoc,
  forTenant,
  type Locale,
  type NotificationDoc,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { sendMail } from "../../shared/mail";
import {
  dueReminder,
  REMINDER_HORIZON_MS,
  type ReminderKey,
} from "./reminder-rules";
import { deliverPush, pushMessage, summaryOf } from "./service";

type ReminderTenant = WithId<
  Pick<
    TenantDoc,
    "name" | "slug" | "customDomain" | "defaultLocale" | "reminders"
  >
>;
type Row = WithId<
  Pick<
    AppointmentDoc,
    | "branchId"
    | "barberId"
    | "customerId"
    | "startAt"
    | "createdAt"
    | "timeZone"
    | "items"
  >
>;
type Customer = WithId<
  Pick<UserDoc, "name" | "guest" | "email" | "contactEmail">
>;

const MAX_PER_TICK = 1000;
const CLAIM_MS = 48 * 60 * 60 * 1000;

const FOOTER: Record<Locale, (host: string) => string> = {
  es: (host) =>
    `¿No puedes ir? Cancela o reprograma desde tu cuenta en ${host}.`,
  en: (host) =>
    `Can't make it? Cancel or reschedule from your account at ${host}.`,
};

export async function sendReminders(tenant: ReminderTenant, now = new Date()) {
  if (tenant.reminders?.enabled === false) return;
  const t = forTenant(tenant._id);
  const host =
    tenant.customDomain ?? `${tenant.slug}.${config.PLATFORM_DOMAIN}`;
  const names = new Map<string, string>();
  const nameOf = async (
    kind: "barbers" | "branches",
    id: ObjectId,
  ): Promise<string | undefined> => {
    const key = `${kind}:${id.toHexString()}`;
    const known = names.get(key);
    if (known !== undefined) return known;
    const doc = await t[kind].findOne({ _id: id }, { projection: { name: 1 } });
    if (doc) names.set(key, doc.name);
    return doc?.name;
  };

  const cursor = t.appointments
    .find({
      status: "confirmed",
      startAt: {
        $gt: now,
        $lte: new Date(now.getTime() + REMINDER_HORIZON_MS),
      },
    })
    .limit(MAX_PER_TICK)
    .project<Row>({
      branchId: 1,
      barberId: 1,
      customerId: 1,
      startAt: 1,
      createdAt: 1,
      timeZone: 1,
      items: 1,
    });

  for await (const row of cursor) {
    const key = dueReminder(row, now);
    if (!key) continue;
    if (!(await claim(row, key, now))) continue;
    const customer = await t.users.findOne(
      { _id: row.customerId },
      { projection: { name: 1, guest: 1, email: 1, contactEmail: 1 } },
    );
    const [branchName, barberName] = await Promise.all([
      nameOf("branches", row.branchId),
      nameOf("barbers", row.barberId),
    ]);
    if (!customer || !branchName) continue;
    await remind(tenant, host, row, customer, branchName, barberName).catch(
      (err: unknown) =>
        console.error(
          JSON.stringify({
            level: "error",
            event: "reminder_failed",
            message: String(err),
          }),
        ),
    );
  }
}

const claim = (row: Row, key: ReminderKey, now: Date) =>
  hit(
    `remind:${row._id.toHexString()}:${row.startAt.getTime()}:${key}`,
    1,
    CLAIM_MS,
    now,
  );

async function remind(
  tenant: ReminderTenant,
  host: string,
  row: Row,
  customer: Customer,
  branchName: string,
  barberName: string | undefined,
) {
  const t = forTenant(tenant._id);
  const note: NotificationDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    userId: customer._id,
    type: "customer.reminder",
    appointmentId: row._id,
    summary: summaryOf(row, { name: branchName }, customer.name, barberName),
    createdAt: new Date(),
  };
  const address = customer.email ?? customer.contactEmail;
  if (!customer.guest) {
    await t.notifications.insertOne(note);
    await deliverPush(tenant, [note]);
  }
  if (address) {
    const message = pushMessage(note, tenant.defaultLocale, tenant.name);
    await sendMail({
      to: address,
      subject: message.title,
      text: `${message.body}\n\n${FOOTER[tenant.defaultLocale](host)}`,
    });
  }
}
