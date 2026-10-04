import { createMiddleware } from "hono/factory";
import type { Plan, TenantDoc } from "../../db/scoped";
import { AppError, type Env } from "../../shared/http";

export const PLAN_LIMITS: Record<Plan, TenantDoc["subscription"]["limits"]> = {
  trial: { branches: 1, barbers: 3 },
  basic: { branches: 1, barbers: 5 },
  pro: { branches: 5, barbers: 30 },
  lifetime: { branches: 50, barbers: 500 },
};

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function isSubscriptionActive(
  subscription: TenantDoc["subscription"],
  now: Date,
) {
  if (subscription.status === "canceled") return false;
  const end = subscription.currentPeriodEnd;
  return !end || now.getTime() <= end.getTime() + GRACE_MS;
}

export const requireActiveSubscription = createMiddleware<Env>(
  async (c, next) => {
    if (!isSubscriptionActive(c.var.tenant.subscription, new Date())) {
      throw new AppError(402, "SUBSCRIPTION_INACTIVE", "Subscription inactive");
    }
    await next();
  },
);
