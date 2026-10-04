import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AppError, type Env, parseId, readJson } from "../../shared/http";
import { STAFF } from "../auth/policy";
import { authOf, requireRole } from "../auth/routes";
import { branchCreate, branchUpdate, tenantUpdate } from "./schemas";
import {
  createBranch,
  getBranch,
  listBranches,
  publicTenant,
  tenantForHost,
  toBranch,
  toTenant,
  updateBranch,
  updateTenant,
} from "./service";
import { requireActiveSubscription } from "./subscription";

export const resolveTenant = createMiddleware<Env>(async (c, next) => {
  const tenant = await tenantForHost(
    c.req.header("X-Forwarded-Host") ?? c.req.header("Host"),
  );
  if (!tenant) throw new AppError(404, "TENANT_NOT_FOUND", "Unknown tenant");
  c.set("tenant", tenant);
  await next();
});

export const publicRoutes = new Hono<Env>().get("/tenant", async (c) =>
  c.json(await publicTenant(c.var.tenant)),
);

export const tenantRoutes = new Hono<Env>()
  .get("/", requireRole(...STAFF), (c) => c.json(toTenant(c.var.tenant)))
  .patch(
    "/",
    requireRole("owner", "admin"),
    requireActiveSubscription,
    async (c) => {
      const input = await readJson(c, tenantUpdate);
      return c.json(toTenant(await updateTenant(c.var.tenant, input)));
    },
  );

export const branchRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) => c.json((await listBranches(authOf(c))).map(toBranch)))
  .get("/:id", async (c) =>
    c.json(toBranch(await getBranch(authOf(c), parseId(c.req.param("id"))))),
  )
  .post(
    "/",
    requireRole("owner", "admin"),
    requireActiveSubscription,
    async (c) => {
      const input = await readJson(c, branchCreate);
      return c.json(toBranch(await createBranch(c.var.tenant, input)), 201);
    },
  )
  .patch(
    "/:id",
    requireRole("owner", "admin", "manager"),
    requireActiveSubscription,
    async (c) => {
      const id = parseId(c.req.param("id"));
      const input = await readJson(c, branchUpdate);
      return c.json(
        toBranch(await updateBranch(c.var.tenant, authOf(c), id, input)),
      );
    },
  );
