import { Hono } from "hono";
import * as z from "zod";
import { type Env, parse } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { listCustomers } from "./service";

const search = z.strictObject({
  q: z.string().trim().max(80).optional(),
});

export const customerRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin", "manager"))
  .get("/", async (c) => {
    const { q } = parse(search, c.req.query());
    return c.json(await listCustomers(authOf(c), c.var.tenant, q));
  });
