import { Hono } from "hono";
import * as z from "zod";
import { type Env, parse, parseId, readJson } from "../../shared/http";
import { STAFF } from "../auth/policy";
import { authOf, requireRole } from "../auth/routes";
import { slug } from "../tenancy/schemas";
import { requireActiveSubscription } from "../tenancy/subscription";
import {
  packageCreate,
  packageUpdate,
  serviceCreate,
  serviceUpdate,
} from "./schemas";
import {
  createPackage,
  createService,
  getPackage,
  getService,
  listPackages,
  listServices,
  publicCatalog,
  toService,
  updatePackage,
  updateService,
} from "./service";

const EDITORS = ["owner", "admin"] as const;

export const serviceRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) => c.json((await listServices(authOf(c))).map(toService)))
  .get("/:id", async (c) =>
    c.json(toService(await getService(authOf(c), parseId(c.req.param("id"))))),
  )
  .post("/", requireRole(...EDITORS), requireActiveSubscription, async (c) => {
    const input = await readJson(c, serviceCreate);
    return c.json(toService(await createService(authOf(c), input)), 201);
  })
  .patch(
    "/:id",
    requireRole(...EDITORS),
    requireActiveSubscription,
    async (c) => {
      const id = parseId(c.req.param("id"));
      const input = await readJson(c, serviceUpdate);
      return c.json(toService(await updateService(authOf(c), id, input)));
    },
  );

export const packageRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) => c.json(await listPackages(authOf(c))))
  .get("/:id", async (c) =>
    c.json(await getPackage(authOf(c), parseId(c.req.param("id")))),
  )
  .post("/", requireRole(...EDITORS), requireActiveSubscription, async (c) => {
    const input = await readJson(c, packageCreate);
    return c.json(await createPackage(authOf(c), input), 201);
  })
  .patch(
    "/:id",
    requireRole(...EDITORS),
    requireActiveSubscription,
    async (c) => {
      const id = parseId(c.req.param("id"));
      const input = await readJson(c, packageUpdate);
      return c.json(await updatePackage(authOf(c), id, input));
    },
  );

export const publicCatalogRoutes = new Hono<Env>().get("/", async (c) => {
  const { branch } = parse(
    z.object({ branch: slug.optional() }),
    c.req.query(),
  );
  return c.json(await publicCatalog(c.var.tenant, branch));
});
