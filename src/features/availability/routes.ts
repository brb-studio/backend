import { Hono } from "hono";
import * as z from "zod";
import { type Env, objectId, parse } from "../../shared/http";
import { STAFF } from "../auth/policy";
import { authOf, requireRole } from "../auth/routes";
import { slug } from "../tenancy/schemas";
import { publicAvailability, staffAvailability } from "./service";

const localDate = z.iso.date();
const days = z.coerce.number().int().min(1).max(31);

export const publicAvailabilityRoutes = new Hono<Env>().get("/", async (c) => {
  const query = parse(
    z
      .object({
        branch: slug,
        service: slug.optional(),
        package: slug.optional(),
        barber: slug.optional(),
        from: localDate.optional(),
        days: days.optional(),
      })
      .refine((q) => !q.service !== !q.package, {
        error: "ask for a service or a package",
      }),
    c.req.query(),
  );
  return c.json(await publicAvailability(c.var.tenant, query));
});

export const staffAvailabilityRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) => {
    const query = parse(
      z
        .object({
          branchId: objectId,
          serviceId: objectId.optional(),
          packageId: objectId.optional(),
          barberId: objectId.optional(),
          from: localDate.optional(),
          days: days.optional(),
        })
        .refine((q) => !q.serviceId !== !q.packageId, {
          error: "ask for a service or a package",
        }),
      c.req.query(),
    );
    return c.json(await staffAvailability(authOf(c), query));
  });
