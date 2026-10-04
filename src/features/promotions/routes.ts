import { Hono } from "hono";
import { type Env, parseId, readJson } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import { promotionCreate, promotionUpdate } from "./schemas";
import {
  createPromotion,
  getPromotion,
  listPromotions,
  toPromotion,
  updatePromotion,
} from "./service";

export const promotionRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin"))
  .get("/", async (c) =>
    c.json((await listPromotions(authOf(c))).map(toPromotion)),
  )
  .get("/:id", async (c) =>
    c.json(
      toPromotion(await getPromotion(authOf(c), parseId(c.req.param("id")))),
    ),
  )
  .post("/", requireActiveSubscription, async (c) => {
    const input = await readJson(c, promotionCreate);
    return c.json(toPromotion(await createPromotion(authOf(c), input)), 201);
  })
  .patch("/:id", requireActiveSubscription, async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await readJson(c, promotionUpdate);
    return c.json(toPromotion(await updatePromotion(authOf(c), id, input)));
  });
