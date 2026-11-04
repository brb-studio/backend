import { Hono } from "hono";
import * as z from "zod";
import { type Env, parse } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { listCustomers } from "./service";

/** Page sizes the panel offers; without them the answer is the first 50, as before paging existed. */
export const CUSTOMER_PAGE_SIZES = [10, 20, 50] as const;

const search = z.strictObject({
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (CUSTOMER_PAGE_SIZES as readonly number[]).includes(n), {
      error: "pageSize must be 10, 20 or 50",
    })
    .default(50),
});

export const customerRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin", "manager"))
  .get("/", async (c) => {
    const { q, page, pageSize } = parse(search, c.req.query());
    return c.json(
      await listCustomers(authOf(c), c.var.tenant, { q, page, pageSize }),
    );
  });
