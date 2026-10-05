import { Hono } from "hono";
import { type Env, readJson } from "../../shared/http";
import { requireRole } from "../auth/routes";
import { checkoutInput, portalInput, referralCheck } from "./schemas";
import {
  billingSummary,
  checkReferral,
  openPortal,
  startCheckout,
} from "./service";

/**
 * The owner pays for the app here. No requireActiveSubscription: an expired barbershop has to be able
 * to pay. Stripe's webhooks arrive through features/payments (one endpoint, one signing secret).
 */
export const billingRoutes = new Hono<Env>()
  .use(requireRole("owner"))
  .get("/", async (c) => c.json(await billingSummary(c.var.tenant)))
  .post("/referral-check", async (c) => {
    const { code } = await readJson(c, referralCheck);
    const { discountPercent } = await checkReferral(c.var.tenant, code);
    return c.json({ code, discountPercent });
  })
  .post("/checkout", async (c) => {
    const input = await readJson(c, checkoutInput);
    return c.json(await startCheckout(c.var.tenant, input), 201);
  })
  .post("/portal", async (c) => {
    const { returnUrl } = await readJson(c, portalInput);
    return c.json(await openPortal(c.var.tenant, returnUrl), 201);
  });
