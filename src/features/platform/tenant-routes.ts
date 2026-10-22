import { Hono } from "hono";
import { type Env, parse, parseId, readJson } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import { createPayout, setCommissionRate } from "./payouts";
import { breakdown, listAppointments } from "./queries";
import { revenue } from "./revenue";
import {
  commissionUpdate,
  filters,
  paging,
  payoutCreate,
  range,
} from "./schemas";

/**
 * Barber earnings inside one barbershop's own admin panel: the same numbers and rules as the global
 * dashboard, but the tenant always comes from the session, never from the request. `/summary` is
 * what the shop itself took in.
 */
export const earningsRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin"))
  .get("/", async (c) => {
    const f = {
      ...parse(filters, c.req.query()),
      tenantId: authOf(c).tenantId,
    };
    return c.json(await breakdown("barber", f, parse(paging, c.req.query())));
  })
  .get("/appointments", async (c) => {
    const f = {
      ...parse(filters, c.req.query()),
      tenantId: authOf(c).tenantId,
    };
    return c.json(await listAppointments(f, parse(paging, c.req.query())));
  })
  .get("/summary", async (c) => {
    const { from, to } = parse(range, c.req.query());
    return c.json(await revenue(c.var.tenant, from, to));
  })
  .patch("/barbers/:id", requireActiveSubscription, async (c) => {
    const { commissionBps } = await readJson(c, commissionUpdate);
    await setCommissionRate(
      parseId(c.req.param("id")),
      commissionBps,
      authOf(c).tenantId,
    );
    return c.body(null, 204);
  })
  .post("/payouts", requireActiveSubscription, async (c) => {
    const auth = authOf(c);
    const input = await readJson(c, payoutCreate);
    return c.json(await createPayout(auth.userId, input, auth.tenantId), 201);
  });
