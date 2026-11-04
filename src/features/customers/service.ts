import type { ObjectId, WithId } from "mongodb";
import { hit } from "../../db/rate-limit";
import {
  type AppointmentDoc,
  forTenant,
  type TenantDb,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { localDate } from "../../shared/time";
import { visibleBranchIds } from "../auth/policy";
import {
  addVisit,
  customerFilter,
  emptyTally,
  type Tally,
  type Visit,
} from "./rules";

const SEARCHES = 60;
const SEARCH_WINDOW_MS = 10 * 60 * 1000;

type Row = WithId<
  Pick<
    UserDoc,
    "name" | "phone" | "email" | "contactEmail" | "guest" | "createdAt"
  >
>;

export async function listCustomers(
  auth: Auth,
  tenant: Pick<TenantDoc, "currency">,
  {
    q,
    page = 1,
    pageSize = 50,
  }: { q?: string | undefined; page?: number; pageSize?: number } = {},
  now = new Date(),
) {
  // Only text searches count (they scan names and emails); paging through the list doesn't.
  if (
    q &&
    !(await hit(`customers:${auth.userId}`, SEARCHES, SEARCH_WINDOW_MS))
  ) {
    throw new AppError(429, "RATE_LIMITED", "Too many searches, try later");
  }
  const t = forTenant(auth.tenantId);
  const branches = visibleBranchIds(auth);
  const scope = branches && (await customersOf(t, branches));
  const filter = {
    ...customerFilter(q),
    ...(scope && { _id: { $in: scope } }),
  };
  const total = await t.users.countDocuments(filter);
  const rows = await collect(
    t.users
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .project<Row>({
        name: 1,
        phone: 1,
        email: 1,
        contactEmail: 1,
        guest: 1,
        createdAt: 1,
      }),
  );
  const tallies = new Map(rows.map((c) => [c._id.toHexString(), emptyTally()]));
  const visits = t.appointments
    .find({
      customerId: { $in: rows.map((c) => c._id) },
      ...(branches && { branchId: { $in: branches } }),
    })
    .project<WithId<Visit & Pick<AppointmentDoc, "customerId">>>({
      customerId: 1,
      status: 1,
      startAt: 1,
      timeZone: 1,
      totalMinor: 1,
    });
  for await (const a of visits) {
    const tally = tallies.get(a.customerId.toHexString());
    if (tally) addVisit(tally, a, now);
  }
  return {
    currency: tenant.currency,
    total,
    page,
    pageSize,
    customers: rows.map((c) => present(c, tallies.get(c._id.toHexString()))),
  };
}

/** A manager only sees customers who booked at least once in their branches. */
async function customersOf(t: TenantDb, branches: ObjectId[]) {
  if (branches.length === 0) return [];
  const ids = new Map<string, ObjectId>();
  const booked = t.appointments
    .find({ branchId: { $in: branches } })
    .project<Pick<AppointmentDoc, "customerId">>({ _id: 0, customerId: 1 });
  for await (const { customerId } of booked) {
    ids.set(customerId.toHexString(), customerId);
  }
  return [...ids.values()];
}

const day = (moment: Tally["last"]) =>
  moment && localDate(moment.at, moment.timeZone);

function present(c: Row, tally = emptyTally()) {
  return {
    id: c._id.toHexString(),
    name: c.name,
    ...(c.phone && { phone: c.phone }),
    ...((c.email ?? c.contactEmail) && { email: c.email ?? c.contactEmail }),
    guest: c.guest === true,
    since: c.createdAt,
    visits: tally.visits,
    noShows: tally.noShows,
    spentMinor: tally.spentMinor,
    ...(tally.last && { lastVisit: day(tally.last) }),
    ...(tally.next && { nextVisit: day(tally.next) }),
  };
}
