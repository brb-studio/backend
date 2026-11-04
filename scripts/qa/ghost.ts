import { ObjectId } from "mongodb";
import type { TenantDoc, UserDoc } from "../../src/db/collections";
import { PLAN_LIMITS } from "../../src/features/tenancy/subscription";

const TRIAL_DAYS = 14;

/**
 * "GhostBarber": exactly what `tenant:create` leaves behind (a trial tenant and its owner), so the
 * whole first-time setup can be done by hand from the panel. The password is the demo one, not a
 * random one, and the email comes already verified.
 */
export function buildGhost(now: Date, passwordHash: string) {
  const tenantId = new ObjectId();
  const tenant: TenantDoc = {
    _id: tenantId,
    slug: "ghostbarber",
    name: "GhostBarber",
    currency: "MXN",
    locales: ["es", "en"],
    defaultLocale: "es",
    brand: {},
    subscription: {
      plan: "trial",
      status: "trialing",
      currentPeriodEnd: new Date(now.getTime() + TRIAL_DAYS * 864e5),
      limits: PLAN_LIMITS.trial,
    },
    createdAt: now,
    updatedAt: now,
  };
  const owner: UserDoc = {
    _id: new ObjectId(),
    tenantId,
    email: "owner@ghostbarber.test",
    passwordHash,
    name: "Dueño GhostBarber",
    role: "owner",
    active: true,
    emailVerifiedAt: now,
    termsAcceptedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  return { tenant, users: [owner] };
}
