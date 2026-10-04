import { Hono } from "hono";
import * as z from "zod";
import {
  type Env,
  objectId,
  parse,
  parseId,
  readJson,
} from "../../shared/http";
import { STAFF } from "../auth/policy";
import { authOf, requireRole } from "../auth/routes";
import { slug } from "../tenancy/schemas";
import { requireActiveSubscription } from "../tenancy/subscription";
import { barberCreate, barberUpdate, timeOffCreate } from "./schemas";
import {
  createBarber,
  getBarber,
  listBarbers,
  publicBarbers,
  toBarber,
  updateBarber,
} from "./service";
import { createTimeOff, deleteTimeOff, listTimeOff } from "./time-off";

const MANAGERS = ["owner", "admin", "manager"] as const;

export const barberRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) => {
    const { branchId } = parse(
      z.object({ branchId: objectId.optional() }),
      c.req.query(),
    );
    return c.json((await listBarbers(authOf(c), branchId)).map(toBarber));
  })
  .get("/:id", async (c) =>
    c.json(toBarber(await getBarber(authOf(c), parseId(c.req.param("id"))))),
  )
  .post("/", requireRole(...MANAGERS), requireActiveSubscription, async (c) => {
    const input = await readJson(c, barberCreate);
    return c.json(
      toBarber(await createBarber(c.var.tenant, authOf(c), input)),
      201,
    );
  })
  .patch(
    "/:id",
    requireRole(...MANAGERS),
    requireActiveSubscription,
    async (c) => {
      const id = parseId(c.req.param("id"));
      const input = await readJson(c, barberUpdate);
      return c.json(
        toBarber(await updateBarber(c.var.tenant, authOf(c), id, input)),
      );
    },
  );

export const timeOffRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) => {
    const query = parse(
      z.object({
        branchId: objectId.optional(),
        barberId: objectId.optional(),
      }),
      c.req.query(),
    );
    return c.json(await listTimeOff(authOf(c), query));
  })
  .post("/", requireActiveSubscription, async (c) => {
    const input = await readJson(c, timeOffCreate);
    return c.json(await createTimeOff(authOf(c), input), 201);
  })
  .delete("/:id", requireActiveSubscription, async (c) => {
    await deleteTimeOff(authOf(c), parseId(c.req.param("id")));
    return c.body(null, 204);
  });

export const publicBarberRoutes = new Hono<Env>().get("/", async (c) => {
  const query = parse(
    z
      .object({
        branch: slug.optional(),
        service: slug.optional(),
        package: slug.optional(),
      })
      .refine((q) => !(q.service && q.package), {
        error: "filter by service or by package, not both",
      }),
    c.req.query(),
  );
  return c.json(await publicBarbers(c.var.tenant, query));
});
