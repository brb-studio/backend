import { forTenant } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import type { Auth } from "../../shared/http";
import { instantToLocal, localToInstant } from "../../shared/time";
import { staffViews } from "./views";

/** The signed-in person's own cuts for today on their branch's clock, whatever their role (barber, or owner who also cuts). */
export async function myDay(auth: Auth, now = new Date()) {
  const t = forTenant(auth.tenantId);
  const barber = await t.barbers.findOne({ userId: auth.userId });
  const branch = barber && (await t.branches.findOne({ _id: barber.branchId }));
  if (!barber || !branch) return { barber: null };

  const date = instantToLocal(now, branch.timeZone).split("T")[0] ?? "";
  const nextDay = Temporal.PlainDate.from(date).add({ days: 1 }).toString();
  const list = await collect(
    t.appointments
      .find({
        barberId: barber._id,
        status: { $in: ["confirmed", "completed"] },
        startAt: {
          $gte: localToInstant(`${date}T00:00`, branch.timeZone),
          $lt: localToInstant(`${nextDay}T00:00`, branch.timeZone),
        },
      })
      .sort({ startAt: 1 })
      .limit(200),
  );
  return {
    barber: { id: barber._id.toHexString(), name: barber.name },
    timeZone: branch.timeZone,
    date,
    appointments: await staffViews(t, list),
  };
}
