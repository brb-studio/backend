import { Hono } from "hono";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import { requestId } from "hono/request-id";
import { config } from "./config";
import { db } from "./db/client";
import { specs } from "./db/collections";
import { ensureCollections } from "./db/setup";
import { authenticate, authRoutes, userRoutes } from "./features/auth/routes";
import {
  publicAvailabilityRoutes,
  staffAvailabilityRoutes,
} from "./features/availability/routes";
import {
  barberRoutes,
  publicBarberRoutes,
  timeOffRoutes,
} from "./features/barbers/routes";
import { billingRoutes } from "./features/billing/routes";
import {
  appointmentRoutes,
  meRoutes,
  publicBookingRoutes,
} from "./features/booking/routes";
import {
  packageRoutes,
  publicCatalogRoutes,
  serviceRoutes,
} from "./features/catalog/routes";
import { imageRoutes, publicImageRoutes } from "./features/images/routes";
import { notificationRoutes } from "./features/notifications/routes";
import {
  stripeConnectRoutes,
  stripePublicRoutes,
  stripeStaffRoutes,
  stripeWebhookRoutes,
} from "./features/payments/routes";
import { platformRoutes } from "./features/platform/routes";
import { earningsRoutes } from "./features/platform/tenant-routes";
import { promotionRoutes } from "./features/promotions/routes";
import {
  branchRoutes,
  publicRoutes,
  resolveTenant,
  tenantRoutes,
} from "./features/tenancy/routes";
import { corsOrigin } from "./shared/cors";
import { type Env, notFound, onError } from "./shared/http";

const securityHeaders = createMiddleware<Env>(async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  if (!c.res.headers.has("Cache-Control"))
    c.header("Cache-Control", "no-store");
});

const accessLog = createMiddleware<Env>(async (c, next) => {
  const started = performance.now();
  await next();
  if (process.env.NODE_ENV === "test") return;
  console.log(
    JSON.stringify({
      level: "info",
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    }),
  );
});

let setup: Promise<void> | undefined;

export const dbReady = () =>
  (setup ??= ensureCollections(db, specs).catch((err: unknown) => {
    setup = undefined;
    throw err;
  }));

const ensureDb = createMiddleware<Env>(async (_c, next) => {
  await dbReady();
  await next();
});

export const app = new Hono<Env>()
  .use(
    cors({
      origin: (origin) =>
        corsOrigin(origin, {
          origins: config.CORS_ORIGINS,
          frontendUrl: config.FRONTEND_URL,
          platformDomain: config.PLATFORM_DOMAIN,
        }),
      allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "X-Forwarded-Host",
        "X-Tenant-Host",
      ],
      exposeHeaders: ["X-Request-Id"],
      maxAge: 600,
    }),
    requestId(),
    securityHeaders,
    accessLog,
    ensureDb,
  )
  .get("/health", async (c) => {
    await db.command({ ping: 1 });
    return c.json({ status: "ok" });
  })
  .route("/images", publicImageRoutes)
  .route("/webhooks/stripe", stripeWebhookRoutes)
  .route("/platform", platformRoutes)
  .use("/v1/*", resolveTenant, authenticate)
  .route("/v1/auth", authRoutes)
  .route("/v1/public", publicRoutes)
  .route("/v1/public", publicBookingRoutes)
  .route("/v1/public/barbers", publicBarberRoutes)
  .route("/v1/public/catalog", publicCatalogRoutes)
  .route("/v1/public/availability", publicAvailabilityRoutes)
  .route("/v1/public", stripePublicRoutes)
  .route("/v1/stripe", stripeConnectRoutes)
  .route("/v1/payments", stripeStaffRoutes)
  .route("/v1/me", meRoutes)
  .route("/v1/tenant", tenantRoutes)
  .route("/v1/billing", billingRoutes)
  .route("/v1/branches", branchRoutes)
  .route("/v1/users", userRoutes)
  .route("/v1/barbers", barberRoutes)
  .route("/v1/time-off", timeOffRoutes)
  .route("/v1/services", serviceRoutes)
  .route("/v1/packages", packageRoutes)
  .route("/v1/availability", staffAvailabilityRoutes)
  .route("/v1/appointments", appointmentRoutes)
  .route("/v1/earnings", earningsRoutes)
  .route("/v1/promotions", promotionRoutes)
  .route("/v1/notifications", notificationRoutes)
  .route("/v1/images", imageRoutes)
  .notFound(notFound)
  .onError(onError);

export default app;
