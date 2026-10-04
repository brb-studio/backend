import { Hono } from "hono";
import { AppError, type Env } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import { findImage, MAX_IMAGE_BYTES, uploadImage } from "./service";

/** Raw image bytes in the body (no multipart): the server sniffs the type itself. */
export const imageRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin", "manager"))
  .post("/", requireActiveSubscription, async (c) => {
    if (Number(c.req.header("Content-Length") ?? 0) > MAX_IMAGE_BYTES) {
      throw new AppError(413, "TOO_LARGE", "Images must be 1 MB or less");
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await uploadImage(authOf(c), bytes), 201);
  });

/** Outside /v1 (no tenant needed): the frontend's image route and Next's optimizer fetch these. */
export const publicImageRoutes = new Hono<Env>().get("/:id", async (c) => {
  const id = c.req.param("id");
  const image = /^[\w-]{22}$/.test(id) ? await findImage(id) : null;
  if (!image) throw new AppError(404, "NOT_FOUND", "Not found");
  return c.body(new Uint8Array(image.data.buffer), 200, {
    "Content-Type": image.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Security-Policy": "default-src 'none'",
  });
});
