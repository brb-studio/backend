import type { ObjectId } from "mongodb";
import type * as z from "zod";
import { forTenant } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { photos } from "../../shared/photos";
import { freeSlots } from "../availability/engine";
import {
  bookableDates,
  engineInput,
  SLOT_BARBER_FIELDS,
  type SlotBarber,
  STAFF_WINDOW_DAYS,
  scheduleOf,
  spanOf,
} from "../availability/service";
import { ownBarberId } from "../barbers/service";
import { notConfirmed } from "./close";
import { bookedMinutes, bookedServiceIds } from "./order";
import type { staffRescheduleQuery } from "./schemas";
import { findVisible } from "./service";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

export const offersAll = (
  barber: Pick<SlotBarber, "serviceIds">,
  needs: ObjectId[],
) =>
  needs.every((id) => barber.serviceIds.some((offered) => offered.equals(id)));

export async function staffRescheduleSlots(
  auth: Auth,
  id: ObjectId,
  query: z.output<typeof staffRescheduleQuery>,
  now = Date.now(),
) {
  const t = forTenant(auth.tenantId);
  const appointment = await findVisible(auth, id);
  if (appointment.status !== "confirmed") throw notConfirmed();
  const branch = await t.branches.findOne({
    _id: appointment.branchId,
    active: true,
  });
  if (!branch) throw notFound();
  const own = auth.role === "barber" ? await ownBarberId(auth) : undefined;
  const only = own ?? query.barberId;
  const needs = bookedServiceIds(appointment.items);
  const barbers = (
    await collect(
      t.barbers
        .find({
          branchId: branch._id,
          active: true,
          ...(only && { _id: only }),
        })
        .sort({ name: 1 })
        .project<SlotBarber>(SLOT_BARBER_FIELDS),
    )
  ).filter((barber) => offersAll(barber, needs));
  const minutes = bookedMinutes(appointment.items);
  const { today, dates } = bookableDates(
    branch.timeZone,
    now,
    STAFF_WINDOW_DAYS,
    query,
  );
  const span = spanOf(dates, branch.timeZone);
  const schedule = span
    ? await scheduleOf(
        t,
        branch,
        barbers.map((b) => b._id),
        span,
        { except: appointment._id },
      )
    : () => ({ blocks: [], busy: [] });
  return {
    branch: { slug: branch.slug, name: branch.name, timeZone: branch.timeZone },
    today,
    dates,
    durationMin: minutes,
    barbers: barbers.map((barber) => ({
      id: barber._id.toHexString(),
      slug: barber.slug,
      name: barber.name,
      image: photos(barber).image,
      days: freeSlots(
        engineInput(branch, barber, minutes, now, schedule(barber._id)),
        dates,
      ).map((day) => ({
        date: day.date,
        slots: day.slots.map((slot) => ({
          startAt: slot.startAt.toISOString(),
          time: slot.time,
        })),
      })),
    })),
  };
}
