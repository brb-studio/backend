import type { WithId } from "mongodb";
import { config } from "../../config";
import {
  type BranchDoc,
  forTenant,
  type Locale,
  type TenantDoc,
  type WaitlistDoc,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { sendMail } from "../../shared/mail";
import { localDate, startOfDay } from "../availability/engine";
import { openSlots } from "../availability/service";
import type { Request } from "../catalog/rules";
import { resolveRequest } from "../catalog/service";
import { deliverMessages } from "../notifications/service";
import { inWindow, NOTIFY_PER_DAY } from "./rules";

type WaitTenant = WithId<
  Pick<TenantDoc, "name" | "slug" | "customDomain" | "defaultLocale">
>;

const MAX_PER_RUN = 300;

const TEXT: Record<
  Locale,
  {
    title: string;
    body: (what: string, where: string, day: string) => string;
    footer: (url: string) => string;
  }
> = {
  es: {
    title: "Se liberó un horario",
    body: (what, where, day) =>
      `${what} · ${where} · ${day}. Reserva antes de que se ocupe.`,
    footer: (url) => `Reserva aquí: ${url}`,
  },
  en: {
    title: "A time just opened up",
    body: (what, where, day) =>
      `${what} · ${where} · ${day}. Book before it's gone.`,
    footer: (url) => `Book here: ${url}`,
  },
};

const originOf = (tenant: WaitTenant) => {
  const host =
    tenant.customDomain ?? `${tenant.slug}.${config.PLATFORM_DOMAIN}`;
  return `${/(^|\.)localhost(:\d+)?$/.test(host) ? "http" : "https"}://${host}`;
};

export async function notifyWaitlist(tenant: WaitTenant, now = new Date()) {
  const t = forTenant(tenant._id);
  const waiting = await collect(
    t.waitlist
      .find({ status: "waiting" })
      .sort({ createdAt: 1 })
      .limit(MAX_PER_RUN),
  );
  const branches = new Map<string, BranchDoc | null>();
  const requests = new Map<string, Request | null>();
  const opens = new Map<string, string[]>();
  const told = new Map<string, number>();

  const branchOf = async (entry: WaitlistDoc) => {
    const key = entry.branchId.toHexString();
    if (!branches.has(key)) {
      branches.set(
        key,
        await t.branches.findOne({ _id: entry.branchId, active: true }),
      );
    }
    return branches.get(key) ?? null;
  };
  const requestOf = async (entry: WaitlistDoc) => {
    const key = `${entry.item.kind}:${entry.item.slug}`;
    if (!requests.has(key)) {
      requests.set(
        key,
        await resolveRequest(tenant._id, {
          [entry.item.kind]: entry.item.slug,
        }).catch(() => null),
      );
    }
    return requests.get(key) ?? null;
  };

  for (const entry of waiting) {
    const branch = await branchOf(entry);
    if (!branch || entry.date < localDate(now, branch.timeZone)) continue;
    const day = `${entry.branchId.toHexString()}:${entry.date}`;
    if ((told.get(day) ?? 0) >= NOTIFY_PER_DAY) continue;

    const request = await requestOf(entry);
    if (!request) {
      await t.waitlist.deleteOne({ _id: entry._id });
      continue;
    }
    const start = startOfDay(entry.date, branch.timeZone);
    const booked = await t.appointments.countDocuments({
      customerId: entry.customerId,
      branchId: branch._id,
      status: { $in: ["confirmed", "pending_payment"] },
      startAt: {
        $gte: new Date(start),
        $lt: new Date(
          startOfDay(
            Temporal.PlainDate.from(entry.date).add({ days: 1 }).toString(),
            branch.timeZone,
          ),
        ),
      },
    });
    if (booked > 0) {
      await t.waitlist.deleteOne({ _id: entry._id });
      continue;
    }

    const key = `${day}:${entry.item.slug}:${entry.barberId?.toHexString() ?? ""}`;
    if (!opens.has(key)) {
      opens.set(
        key,
        await openSlots(
          tenant,
          branch,
          request,
          { date: entry.date, barberId: entry.barberId },
          now.getTime(),
        ),
      );
    }
    const times = opens.get(key) ?? [];
    if (!times.some((time) => inWindow(time, entry.from, entry.to))) continue;

    const claimed = await t.waitlist.findOneAndUpdate(
      { _id: entry._id, status: "waiting" },
      { $set: { status: "notified", notifiedAt: now } },
    );
    if (!claimed) continue;
    told.set(day, (told.get(day) ?? 0) + 1);
    await tell(tenant, branch, entry).catch((err: unknown) =>
      console.error(
        JSON.stringify({
          level: "error",
          event: "waitlist_notify_failed",
          message: String(err),
        }),
      ),
    );
  }
}

async function tell(tenant: WaitTenant, branch: BranchDoc, entry: WaitlistDoc) {
  const locale = tenant.defaultLocale;
  const text = TEXT[locale];
  const what =
    entry.item.name[locale] ?? entry.item.name.es ?? entry.item.name.en ?? "";
  const day = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${entry.date}T00:00:00Z`));
  const path = `/${locale}/services/${entry.item.slug}?branch=${branch.slug}`;
  const message = {
    title: `${text.title} · ${tenant.name}`,
    body: text.body(what, branch.name, day),
    tag: `waitlist:${entry._id.toHexString()}`,
    url: path,
  };
  await deliverMessages(tenant, [{ userId: entry.customerId, message }]);
  const customer = await forTenant(tenant._id).users.findOne(
    { _id: entry.customerId },
    { projection: { email: 1 } },
  );
  if (customer?.email) {
    await sendMail({
      to: customer.email,
      subject: message.title,
      text: `${message.body}\n\n${text.footer(`${originOf(tenant)}${path}`)}`,
    });
  }
}
