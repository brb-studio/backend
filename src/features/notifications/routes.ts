import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as z from "zod";
import { subscribe } from "../../db/notification-hub";
import { type Env, objectId, readJson } from "../../shared/http";
import { isPushEndpoint } from "../../shared/web-push";
import { STAFF } from "../auth/policy";
import { authOf, requireRole } from "../auth/routes";
import {
  listNotifications,
  markRead,
  pushPublicKey,
  subscribePush,
  toNotification,
  unsubscribePush,
} from "./service";

const bytes = (length: number, first?: number) =>
  z.string().refine(
    (value) => {
      const decoded = Buffer.from(value, "base64url");
      return (
        decoded.length === length &&
        (first === undefined || decoded[0] === first)
      );
    },
    { error: `must be  bytes, base64url` },
  );

const endpoint = z
  .string()
  .max(2048)
  .refine(isPushEndpoint, { error: "must be a push service URL" });

const pushSubscription = z.object({
  endpoint,
  keys: z.object({ p256dh: bytes(65, 4), auth: bytes(16) }),
});

const HEARTBEAT_MS = 15_000;

export const notificationRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) => c.json(await listNotifications(authOf(c))))
  .post("/read", async (c) => {
    const { ids } = await readJson(
      c,
      z.strictObject({ ids: z.array(objectId).max(100).optional() }),
    );
    await markRead(authOf(c), ids);
    return c.body(null, 204);
  })
  .get("/push-key", (c) => {
    const publicKey = pushPublicKey();
    if (!publicKey)
      return c.json(
        { error: { code: "PUSH_DISABLED", message: "Push is not configured" } },
        404,
      );
    return c.json({ publicKey });
  })
  .post("/push-subscriptions", async (c) => {
    await subscribePush(authOf(c), await readJson(c, pushSubscription));
    return c.body(null, 204);
  })
  .delete("/push-subscriptions", async (c) => {
    const input = await readJson(c, z.object({ endpoint }));
    await unsubscribePush(authOf(c), input.endpoint);
    return c.body(null, 204);
  })
  .get("/stream", (c) => {
    const auth = authOf(c);
    return streamSSE(c, async (stream) => {
      const { ready, unsubscribe } = subscribe(auth.userId, (doc) => {
        stream
          .writeSSE({
            event: "notification",
            id: doc._id.toHexString(),
            data: JSON.stringify(toNotification(doc)),
          })
          .catch(() => unsubscribe());
      });
      stream.onAbort(unsubscribe);
      await ready;
      await stream.writeSSE({ event: "ready", data: "" });
      while (!stream.aborted) {
        await stream.sleep(HEARTBEAT_MS);
        if (!stream.aborted) await stream.writeSSE({ event: "ping", data: "" });
      }
      unsubscribe();
    });
  });
