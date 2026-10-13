import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import {
  AppError,
  type Env,
  parse,
  parseId,
  readJson,
} from "../../shared/http";
import { STAFF } from "../auth/policy";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import {
  createProduct,
  listProducts,
  publicProducts,
  toProduct,
  updateProduct,
} from "./catalog";
import { cancelMyOrder, listMyOrders, reserveProducts } from "./orders";
import {
  cancelOrderAsStaff,
  deliverOrder,
  pendingOrders,
  scanOrder,
} from "./pickup";
import {
  deliverBody,
  productCreate,
  productUpdate,
  publicQuery,
  reserveBody,
  scanBody,
} from "./schemas";

const EDITORS = ["owner", "admin"] as const;

const requireProducts = createMiddleware<Env>(async (c, next) => {
  if (!c.var.tenant.products?.enabled) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  await next();
});

export const publicProductRoutes = new Hono<Env>()
  .use(requireProducts)
  .get("/", async (c) =>
    c.json(
      await publicProducts(
        c.var.tenant,
        parse(publicQuery, c.req.query()).branch,
      ),
    ),
  );

export const productRoutes = new Hono<Env>()
  .use(requireProducts, requireRole(...STAFF))
  .get("/", async (c) => c.json((await listProducts(authOf(c))).map(toProduct)))
  .post("/", requireRole(...EDITORS), requireActiveSubscription, async (c) =>
    c.json(
      toProduct(
        await createProduct(authOf(c), await readJson(c, productCreate)),
      ),
      201,
    ),
  )
  .patch(
    "/:id",
    requireRole(...EDITORS),
    requireActiveSubscription,
    async (c) =>
      c.json(
        toProduct(
          await updateProduct(
            authOf(c),
            parseId(c.req.param("id")),
            await readJson(c, productUpdate),
          ),
        ),
      ),
  );

export const myProductOrderRoutes = new Hono<Env>()
  .use(requireProducts, requireRole("customer"))
  .get("/", async (c) => c.json(await listMyOrders(c.var.tenant, authOf(c))))
  .post("/", requireActiveSubscription, async (c) => {
    const id = await reserveProducts(
      c.var.tenant,
      authOf(c),
      await readJson(c, reserveBody),
    );
    return c.json({ id: id.toHexString() }, 201);
  })
  .post("/:id/cancel", async (c) => {
    await cancelMyOrder(c.var.tenant, authOf(c), parseId(c.req.param("id")));
    return c.body(null, 204);
  });

export const pickupRoutes = new Hono<Env>()
  .use(requireProducts, requireRole(...STAFF))
  .get("/", async (c) => c.json(await pendingOrders(c.var.tenant, authOf(c))))
  .post("/scan", async (c) =>
    c.json(
      await scanOrder(
        c.var.tenant,
        authOf(c),
        (await readJson(c, scanBody)).code,
      ),
    ),
  )
  .post("/:id/deliver", requireActiveSubscription, async (c) =>
    c.json(
      await deliverOrder(
        c.var.tenant,
        authOf(c),
        parseId(c.req.param("id")),
        (await readJson(c, deliverBody)).method,
      ),
    ),
  )
  .post("/:id/cancel", async (c) => {
    await cancelOrderAsStaff(
      c.var.tenant,
      authOf(c),
      parseId(c.req.param("id")),
    );
    return c.body(null, 204);
  });
