import type { ObjectId, WithId } from "mongodb";
import { hit } from "../../db/rate-limit";
import { forTenant, type Locale, type TenantDoc } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { instantToLocal, localToInstant } from "../../shared/time";
import { deliverMessages, type PushMessage } from "./service";

/** Morning summary window, in each branch's own clock: sent once, never late in the day. */
const FIRST_HOUR = 8;
const LAST_HOUR = 12;
const SENT_FOR_MS = 36 * 60 * 60 * 1000;
const MAX_PENDING = 500;

type DigestTenant = WithId<Pick<TenantDoc, "name" | "defaultLocale">>;

const TEXT: Record<
  Locale,
  {
    title: string;
    today: (n: number) => string;
    pending: (n: number) => string;
  }
> = {
  es: {
    title: "Resumen del día",
    today: (n) => `${n} ${n === 1 ? "cita" : "citas"} hoy`,
    pending: (n) =>
      `${n} ${n === 1 ? "transferencia" : "transferencias"} por confirmar`,
  },
  en: {
    title: "Today's summary",
    today: (n) => `${n} ${n === 1 ? "appointment" : "appointments"} today`,
    pending: (n) => `${n} ${n === 1 ? "transfer" : "transfers"} to confirm`,
  },
};

/**
 * One push per branch to owners and admins (an owner who is also a barber still gets their own
 * appointments one by one): appointments today and SPEI transfers waiting for confirmation.
 * Safe to call as often as you like: each branch is claimed once per local day.
 */
export async function sendDigest(tenant: DigestTenant, now = new Date()) {
  const t = forTenant(tenant._id);
  const recipients = await collect(
    t.users
      .find({ role: { $in: ["owner", "admin"] }, active: true }, { limit: 50 })
      .project<{ _id: ObjectId }>({ _id: 1 }),
    (u) => u._id,
  );
  if (recipients.length === 0) return;
  const branches = await collect(
    t.branches.find({ active: true }).project<{
      _id: ObjectId;
      name: string;
      timeZone: string;
    }>({ name: 1, timeZone: 1 }),
  );
  const text = TEXT[tenant.defaultLocale];
  let pendingIds: ObjectId[] | undefined;

  for (const branch of branches) {
    const [date = "", time = ""] = instantToLocal(now, branch.timeZone).split(
      "T",
    );
    const hour = Number(time.slice(0, 2));
    if (hour < FIRST_HOUR || hour >= LAST_HOUR) continue;
    if (!(await hit(`digest:${branch._id}:${date}`, 1, SENT_FOR_MS))) continue;

    const nextDay = Temporal.PlainDate.from(date).add({ days: 1 }).toString();
    const today = await t.appointments.countDocuments({
      branchId: branch._id,
      status: "confirmed",
      startAt: {
        $gte: localToInstant(`${date}T00:00`, branch.timeZone),
        $lt: localToInstant(`${nextDay}T00:00`, branch.timeZone),
      },
    });
    pendingIds ??= await collect(
      t.payments
        .find({ method: "spei", status: "pending" })
        .limit(MAX_PENDING)
        .project<{ appointmentId: ObjectId }>({
          appointmentId: 1,
        }),
      (p) => p.appointmentId,
    );
    const pending = pendingIds.length
      ? await t.appointments.countDocuments({
          _id: { $in: pendingIds },
          branchId: branch._id,
        })
      : 0;
    if (today === 0 && pending === 0) continue;

    const message: PushMessage = {
      title: `${text.title} · ${tenant.name}`,
      body: [
        branches.length > 1 ? branch.name : "",
        today > 0 ? text.today(today) : "",
        pending > 0 ? text.pending(pending) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      tag: `digest:${branch._id.toHexString()}`,
      url: `/${tenant.defaultLocale}/admin`,
    };
    await deliverMessages(
      tenant,
      recipients.map((userId) => ({ userId, message })),
    );
  }
}
