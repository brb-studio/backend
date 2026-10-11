import { Hono } from "hono";
import { type Env, readJson } from "../../shared/http";
import { requireRole } from "../auth/routes";
import { paymentInput, referralCheck } from "./schemas";
import { billingSummary, checkReferral, createPayment } from "./service";

/**
 * The owner pays for the app here, by SPEI transfer to the project's account. No requireActiveSubscription:
 * an expired barbershop has to be able to pay. Platform staff confirm the transfers (features/platform).
 */
export const billingRoutes = new Hono<Env>()
  .use(requireRole("owner"))
  .get("/", async (c) => c.json(await billingSummary(c.var.tenant)))
  .post("/referral-check", async (c) => {
    const { code } = await readJson(c, referralCheck);
    const { discountPercent } = await checkReferral(c.var.tenant, code);
    return c.json({ code, discountPercent });
  })
  .post("/payment", async (c) => {
    const input = await readJson(c, paymentInput);
    return c.json(await createPayment(c.var.tenant, input), 201);
  });
