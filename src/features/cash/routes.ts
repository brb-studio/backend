import { Hono } from "hono";
import * as z from "zod";
import { type Env, objectId, parse } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { cashDay } from "./service";

const day = z.strictObject({
  date: z.iso.date(),
  branchId: objectId.optional(),
});

export const cashRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin", "manager"))
  .get("/", async (c) => {
    const { date, branchId } = parse(day, c.req.query());
    return c.json(await cashDay(c.var.tenant, authOf(c), date, branchId));
  });
