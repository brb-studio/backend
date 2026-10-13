import { Hono } from "hono";
import { type Env, parseId, readJson } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import { joinBody } from "./schemas";
import { joinWaitlist, leaveWaitlist, listMyWaitlist } from "./service";

export const waitlistRoutes = new Hono<Env>()
  .use(requireRole("customer"))
  .get("/", async (c) => c.json(await listMyWaitlist(c.var.tenant, authOf(c))))
  .post("/", requireActiveSubscription, async (c) =>
    c.json(
      await joinWaitlist(c.var.tenant, authOf(c), await readJson(c, joinBody)),
      201,
    ),
  )
  .delete("/:id", async (c) => {
    await leaveWaitlist(c.var.tenant, authOf(c), parseId(c.req.param("id")));
    return c.body(null, 204);
  });
