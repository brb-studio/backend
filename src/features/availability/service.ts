import type { ClientSession, ObjectId } from "mongodb";
import {
  type BarberDoc,
  type BranchDoc,
  forTenant,
  type TenantDb,
  type TenantDoc,
} from "../../db/scoped";
import { AppError, type Auth } from "../../shared/http";
import { photos } from "../../shared/photos";
import { ownBarberId } from "../barbers/service";
import { canServe, type Request, totals } from "../catalog/rules";
import { resolveRequest } from "../catalog/service";
import { getBranch } from "../tenancy/service";
import {
  type EngineInput,
  freeSlots,
  type Interval,
  startOfDay,
} from "./engine";

const DAY_MS = 24 * 60 * 60 * 1000;
export const STAFF_WINDOW_DAYS = 365;
const MAX_DAYS_PER_QUERY = 31;

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

export function bookableDates(
  timeZone: string,
  now: number,
  windowDays: number,
  range: { from?: string; days?: number } = {},
) {
  const today = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  const last = today.add({ days: windowDays - 1 });
  let day = range.from ? Temporal.PlainDate.from(range.from) : today;
  if (Temporal.PlainDate.compare(day, today) < 0) day = today;
  const dates: string[] = [];
  const limit = Math.min(range.days ?? windowDays, MAX_DAYS_PER_QUERY);
  while (Temporal.PlainDate.compare(day, last) <= 0 && dates.length < limit) {
    dates.push(day.toString());
    day = day.add({ days: 1 });
  }
  return { today: today.toString(), dates };
}

export const spanOf = (dates: string[], timeZone: string): Interval | null => {
  const [first] = dates;
  const last = dates.at(-1);
  if (!first || !last) return null;
  return {
    start: startOfDay(first, timeZone),
    end: startOfDay(
      Temporal.PlainDate.from(last).add({ days: 1 }).toString(),
      timeZone,
    ),
  };
};

export async function scheduleOf(
  t: TenantDb,
  branch: BranchDoc,
  barberIds: ObjectId[],
  span: Interval,
  options: { session?: ClientSession; except?: ObjectId } = {},
) {
  const { session } = options;
  const findOff = () =>
    t.timeOff
      .find(
        {
          branchId: branch._id,
          startAt: { $lt: new Date(span.end) },
          endAt: { $gt: new Date(span.start) },
          $or: [
            { barberId: { $in: barberIds } },
            { barberId: { $exists: false } },
          ],
        },
        { session, projection: { barberId: 1, startAt: 1, endAt: 1 } },
      )
      .toArray();
  const findBooked = () =>
    t.appointments
      .find(
        {
          barberId: { $in: barberIds },
          status: "confirmed",
          startAt: {
            $gte: new Date(span.start - DAY_MS),
            $lt: new Date(span.end),
          },
          blockedUntil: { $gt: new Date(span.start) },
          ...(options.except && { _id: { $ne: options.except } }),
        },
        { session, projection: { barberId: 1, startAt: 1, blockedUntil: 1 } },
      )
      .toArray();
  const [off, booked] = session
    ? [await findOff(), await findBooked()]
    : await Promise.all([findOff(), findBooked()]);
  return (barberId: ObjectId) => ({
    blocks: off
      .filter((o) => !o.barberId || o.barberId.equals(barberId))
      .map((o) => ({ start: o.startAt.getTime(), end: o.endAt.getTime() })),
    busy: booked
      .filter((a) => a.barberId.equals(barberId))
      .map((a) => ({
        start: a.startAt.getTime(),
        end: a.blockedUntil.getTime(),
      })),
  });
}

export const engineInput = (
  branch: BranchDoc,
  barber: BarberDoc,
  durationMin: number,
  earliest: number,
  schedule: Pick<EngineInput, "blocks" | "busy">,
): EngineInput => ({
  timeZone: branch.timeZone,
  slotIntervalMin: branch.booking.slotIntervalMin,
  bufferMin: branch.booking.bufferMin,
  branchHours: branch.hours,
  barberHours: barber.hours,
  durationMin,
  earliest,
  ...schedule,
});

async function availability(
  t: TenantDb,
  branch: BranchDoc,
  request: Request,
  barbers: BarberDoc[],
  options: {
    now: number;
    earliest: number;
    windowDays: number;
    from?: string;
    days?: number;
  },
) {
  const able = barbers.filter((b) => canServe(b, request));
  const { durationMin } = totals(request.services);
  const { today, dates } = bookableDates(
    branch.timeZone,
    options.now,
    options.windowDays,
    options,
  );
  const span = spanOf(dates, branch.timeZone);
  const schedule = span
    ? await scheduleOf(
        t,
        branch,
        able.map((b) => b._id),
        span,
      )
    : () => ({ blocks: [], busy: [] });
  return {
    branch: { slug: branch.slug, name: branch.name, timeZone: branch.timeZone },
    today,
    dates,
    durationMin,
    barbers: able.map((barber) => ({
      id: barber._id.toHexString(),
      slug: barber.slug,
      name: barber.name,
      image: photos(barber).image,
      days: freeSlots(
        engineInput(
          branch,
          barber,
          durationMin,
          options.earliest,
          schedule(barber._id),
        ),
        dates,
      ).map((day) => ({
        date: day.date,
        slots: day.slots.map((s) => ({
          startAt: s.startAt.toISOString(),
          time: s.time,
        })),
      })),
    })),
  };
}

export async function publicAvailability(
  tenant: TenantDoc,
  query: {
    branch: string;
    service?: string;
    package?: string;
    barber?: string;
    from?: string;
    days?: number;
  },
  now = Date.now(),
) {
  const t = forTenant(tenant._id);
  const [branch, request] = await Promise.all([
    t.branches.findOne({ slug: query.branch, active: true }),
    resolveRequest(tenant._id, query),
  ]);
  if (!branch) throw notFound();
  const barbers = await t.barbers
    .find({
      branchId: branch._id,
      active: true,
      ...(query.barber && { slug: query.barber }),
    })
    .sort({ name: 1 })
    .toArray();
  if (query.barber && !barbers.some((b) => canServe(b, request)))
    throw notFound();
  return availability(t, branch, request, barbers, {
    now,
    earliest: now + branch.booking.minNoticeMin * 60_000,
    windowDays: branch.booking.windowDays,
    from: query.from,
    days: query.days,
  });
}

export async function staffAvailability(
  auth: Auth,
  query: {
    branchId: ObjectId;
    serviceId?: ObjectId;
    packageId?: ObjectId;
    barberId?: ObjectId;
    from?: string;
    days?: number;
  },
  now = Date.now(),
) {
  const t = forTenant(auth.tenantId);
  const [branch, request, own] = await Promise.all([
    getBranch(auth, query.branchId),
    resolveRequest(auth.tenantId, query),
    auth.role === "barber" ? ownBarberId(auth) : undefined,
  ]);
  if (auth.role === "barber" && !own)
    return availability(t, branch, request, [], {
      now,
      earliest: now,
      windowDays: STAFF_WINDOW_DAYS,
    });
  const barbers = await t.barbers
    .find({
      branchId: branch._id,
      active: true,
      ...(query.barberId && { _id: query.barberId }),
      ...(own && { _id: own }),
    })
    .sort({ name: 1 })
    .toArray();
  return availability(t, branch, request, barbers, {
    now,
    earliest: now,
    windowDays: STAFF_WINDOW_DAYS,
    from: query.from,
    days: query.days,
  });
}
