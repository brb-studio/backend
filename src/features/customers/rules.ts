import type { Filter } from "mongodb";
import type { AppointmentDoc, UserDoc } from "../../db/scoped";

const PHONE_LIKE = /^[\d\s()+-]+$/;

export function customerFilter(q?: string): Filter<UserDoc> {
  const base: Filter<UserDoc> = {
    role: "customer",
    deletedAt: { $exists: false },
  };
  if (!q) return base;
  const digits = q.replace(/\D/g, "");
  if (PHONE_LIKE.test(q) && digits) {
    return { ...base, phone: { $regex: digits } };
  }
  const pattern = { $regex: RegExp.escape(q), $options: "i" };
  return {
    ...base,
    $or: [{ name: pattern }, { email: pattern }, { contactEmail: pattern }],
  };
}

export type Visit = Pick<
  AppointmentDoc,
  "status" | "startAt" | "timeZone" | "totalMinor"
>;
type Moment = { at: Date; timeZone: string };
export type Tally = {
  visits: number;
  noShows: number;
  spentMinor: number;
  last?: Moment;
  next?: Moment;
};

export const emptyTally = (): Tally => ({
  visits: 0,
  noShows: 0,
  spentMinor: 0,
});

export function addVisit(tally: Tally, a: Visit, now: Date) {
  const moment = { at: a.startAt, timeZone: a.timeZone };
  if (a.status === "completed") {
    tally.visits++;
    tally.spentMinor += a.totalMinor;
    if (!tally.last || a.startAt > tally.last.at) tally.last = moment;
  } else if (a.status === "no_show") {
    tally.noShows++;
  } else if (
    a.status === "confirmed" &&
    a.startAt > now &&
    (!tally.next || a.startAt < tally.next.at)
  ) {
    tally.next = moment;
  }
}
