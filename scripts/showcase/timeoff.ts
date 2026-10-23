import type {
  BarberDoc,
  BranchDoc,
  TimeOffDoc,
} from "../../src/db/collections";
import {
  instantToLocal,
  localDate,
  localToInstant,
} from "../../src/shared/time";
import type { Catalog } from "./catalog";
import { oid, plainDay, TENANT_ID, toMinutes, weekdayOf } from "./ids";
import type { People } from "./people";

/** Time off in local terms, turned into documents (and into gaps in the agenda). */
export function buildTimeOff(
  catalog: Catalog,
  people: People,
  now: Date,
): TimeOffDoc[] {
  const branch = (slug: string) =>
    catalog.branches.find((b) => b.slug === slug);
  const today = (b: BranchDoc) => localDate(now, b.timeZone);
  const docs: TimeOffDoc[] = [];
  const add = (
    key: string,
    b: BranchDoc | undefined,
    barberSlug: string | undefined,
    from: string,
    to: string,
    kind: TimeOffDoc["kind"],
    reason: string,
  ) => {
    if (!b) return;
    const startAt = localToInstant(from, b.timeZone);
    const endAt = localToInstant(to, b.timeZone);
    docs.push({
      _id: oid(`timeoff:${key}`),
      tenantId: TENANT_ID,
      branchId: b._id,
      ...(barberSlug && { barberId: oid(`barber:${barberSlug}`) }),
      startAt,
      endAt,
      kind,
      reason,
      createdBy: people.ids.owner,
      createdAt: new Date(
        Math.min(startAt.getTime(), now.getTime()) - 3 * 864e5,
      ),
    });
  };
  const polanco = branch("polanco");
  if (polanco) {
    const day = today(polanco);
    const working = people.barbers.find(
      (b) =>
        b.branchId.equals(polanco._id) &&
        b.hours.some(
          (h) =>
            h.weekday === weekdayOf(day) &&
            h.open <= "12:30" &&
            h.close >= "13:00",
        ),
    );
    if (working)
      add(
        "break-today",
        polanco,
        working.slug,
        `${day}T12:30`,
        `${day}T13:00`,
        "break",
        "Comida",
      );
  }
  const prov = branch("providencia");
  if (prov) {
    const day = today(prov);
    add(
      "vacation",
      prov,
      "mauricio",
      `${plainDay(day, 7)}T00:00`,
      `${plainDay(day, 12)}T00:00`,
      "vacation",
      "Vacaciones",
    );
    add(
      "closure-past",
      prov,
      undefined,
      `${plainDay(day, -20)}T00:00`,
      `${plainDay(day, -19)}T00:00`,
      "closure",
      "Mantenimiento del local",
    );
  }
  const sp = branch("sanpedro");
  if (sp) {
    const day = today(sp);
    add(
      "block-tomorrow",
      sp,
      "joaquin",
      `${plainDay(day, 1)}T16:00`,
      `${plainDay(day, 1)}T18:00`,
      "block",
      "Curso de colorimetría",
    );
    add(
      "closure-future",
      sp,
      undefined,
      `${plainDay(day, 9)}T00:00`,
      `${plainDay(day, 10)}T00:00`,
      "closure",
      "Día festivo",
    );
    add(
      "time-off",
      sp,
      "andres",
      `${plainDay(day, -3)}T14:00`,
      `${plainDay(day, -3)}T18:00`,
      "time_off",
      "Cita médica",
    );
  }
  return docs;
}

export type Interval = [number, number];

export function busyFrom(
  timeOff: TimeOffDoc[],
  barber: BarberDoc,
  date: string,
  timeZone: string,
): Interval[] {
  const minuteOf = (at: Date) => {
    const local = instantToLocal(at, timeZone);
    const day = local.slice(0, 10);
    if (day < date) return 0;
    if (day > date) return 1440;
    return toMinutes(local.slice(11));
  };
  return timeOff
    .filter(
      (t) =>
        t.branchId.equals(barber.branchId) &&
        (!t.barberId || t.barberId.equals(barber._id)),
    )
    .map((t): Interval => [minuteOf(t.startAt), minuteOf(t.endAt)])
    .filter(([a, b]) => a < b);
}
