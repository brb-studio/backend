import { Hono } from "hono";
import { type Env, parse, readJson } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import { createEntry } from "./entries";
import { entryBody, movementsQuery, summaryQuery } from "./schemas";
import { moneyMovements, moneySummary } from "./service";

export const moneyRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin", "manager"))
  .get("/summary", async (c) =>
    c.json(
      await moneySummary(
        c.var.tenant,
        authOf(c),
        parse(summaryQuery, c.req.query()),
      ),
    ),
  )
  .get("/movements", async (c) =>
    c.json(
      await moneyMovements(
        c.var.tenant,
        authOf(c),
        parse(movementsQuery, c.req.query()),
      ),
    ),
  )
  .post(
    "/entries",
    requireRole("owner", "admin"),
    requireActiveSubscription,
    async (c) =>
      c.json(
        await createEntry(
          c.var.tenant,
          authOf(c),
          await readJson(c, entryBody),
        ),
        201,
      ),
  );
