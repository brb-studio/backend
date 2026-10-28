import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { ObjectId } from "mongodb";
import {
  AppError,
  type Auth,
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
  stockBody,
} from "./schemas";
import { type StockRow, setStock, stockRows } from "./stock";

const EDITORS = ["owner", "admin"] as const;

const requireProducts = createMiddleware<Env>(async (c, next) => {
  if (!c.var.tenant.products?.enabled) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  await next();
});

const stockOf = async (auth: Auth, id: ObjectId): Promise<StockRow[]> =>
  (await stockRows(auth, [id])).get(id.toHexString()) ?? [];

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
  .get("/", async (c) => {
    const auth = authOf(c);
    const list = await listProducts(auth);
    const stock = await stockRows(
      auth,
      list.map((p) => p._id),
    );
    return c.json(
      list.map((p) => toProduct(p, stock.get(p._id.toHexString()) ?? [])),
    );
  })
  .post("/", requireRole(...EDITORS), requireActiveSubscription, async (c) =>
    c.json(
      toProduct(
        await createProduct(authOf(c), await readJson(c, productCreate)),
        [],
      ),
      201,
    ),
  )
  .patch(
    "/:id",
    requireRole(...EDITORS),
    requireActiveSubscription,
    async (c) => {
      const auth = authOf(c);
      const product = await updateProduct(
        auth,
        parseId(c.req.param("id")),
        await readJson(c, productUpdate),
      );
      return c.json(toProduct(product, await stockOf(auth, product._id)));
    },
  )
  .put(
    "/:id/stock/:branchId",
    requireRole("owner", "admin", "manager"),
    requireActiveSubscription,
    async (c) => {
      const auth = authOf(c);
      const productId = parseId(c.req.param("id"));
      const { quantity } = await readJson(c, stockBody);
      await setStock(
        auth,
        productId,
        parseId(c.req.param("branchId")),
        quantity,
      );
      return c.json({ stock: await stockOf(auth, productId) });
    },
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
