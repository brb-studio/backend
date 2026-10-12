import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { config } from "../../config";
import { AppError, type Env } from "../../shared/http";
import { runDigests } from "./digest";

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET` with a GET; any pinger can do the same. */
export const cronRoutes = new Hono<Env>().get("/digest", async (c) => {
  const secret = config.CRON_SECRET;
  const given = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !same(given, secret)) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  await runDigests();
  return c.body(null, 204);
});
