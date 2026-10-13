import { timingSafeEqual } from "node:crypto";
import { type Context, Hono } from "hono";
import { config } from "../../config";
import { AppError, type Env } from "../../shared/http";
import { runScheduled } from "./digest";

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function tick(c: Context<Env>) {
  const secret = config.CRON_SECRET;
  const given = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !same(given, secret)) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  await runScheduled();
  return c.body(null, 204);
}

export const cronRoutes = new Hono<Env>()
  .get("/tick", tick)
  .get("/digest", tick);
