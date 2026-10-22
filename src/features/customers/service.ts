import type { WithId } from "mongodb";
import {
  type AppointmentDoc,
  forTenant,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import type { Auth } from "../../shared/http";
import { localDate } from "../../shared/time";
import { visibleBranchIds } from "../auth/policy";
import {
  addVisit,
  customerFilter,
  emptyTally,
  type Tally,
  type Visit,
} from "./rules";

const LIMIT = 50;

type Row = WithId<
  Pick<
    UserDoc,
    "name" | "phone" | "email" | "contactEmail" | "guest" | "createdAt"
  >
>;

export async function listCustomers(
  auth: Auth,
  tenant: Pick<TenantDoc, "currency">,
  q?: string,
  now = new Date(),
) {
  const t = forTenant(auth.tenantId);
  const rows = await collect(
    t.users
      .find(customerFilter(q))
      .sort({ createdAt: -1 })
      .limit(LIMIT)
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
  const branches = visibleBranchIds(auth);
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
    customers: rows.map((c) => present(c, tallies.get(c._id.toHexString()))),
  };
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
