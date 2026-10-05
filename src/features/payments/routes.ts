import { Hono } from "hono";
import type Stripe from "stripe";
import { config } from "../../config";
import { hit } from "../../db/rate-limit";
import {
  AppError,
  clientIp,
  type Env,
  parseId,
  readJson,
} from "../../shared/http";
import { STAFF } from "../auth/policy";
import { requireRole } from "../auth/routes";
import { handleBillingEvent } from "../billing/service";
import { requireActiveSubscription } from "../tenancy/subscription";
import { paymentIntentBody } from "./schemas";
import {
  connectStatus,
  createOnboardingLink,
  createPaymentIntent,
  handleStripeEvent,
  handleThinNotification,
  refundAppointment,
} from "./service";
import { paymentsEnabled, requireStripe, validPaymentToken } from "./stripe";

export const stripeConnectRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/status", async (c) => {
    if (!paymentsEnabled()) {
      return c.json({ connected: false, accountId: null });
    }
    return c.json(await connectStatus(c.var.tenant));
  })
  .post(
    "/connect",
    requireRole("owner", "admin"),
    requireActiveSubscription,
    async (c) => c.json(await createOnboardingLink(c.var.tenant), 201),
  );

export const stripeStaffRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin", "manager"))
  .post("/:id/refund", requireActiveSubscription, async (c) =>
    c.json(await refundAppointment(c.var.tenant, parseId(c.req.param("id")))),
  );

export const stripePublicRoutes = new Hono<Env>().post(
  "/payments/intent",
  requireActiveSubscription,
  async (c) => {
    if (!paymentsEnabled()) {
      throw new AppError(
        503,
        "PAYMENTS_DISABLED",
        "Online payments are not enabled",
      );
    }
    const ip = clientIp(c, config.PROXY_SECRET);
    if (!(await hit(`pay:${c.var.tenant._id}:${ip}`, 30, 10 * 60 * 1000))) {
      throw new AppError(429, "RATE_LIMITED", "Too many attempts");
    }
    const { appointmentId, paymentToken } = await readJson(
      c,
      paymentIntentBody,
    );
    const auth = c.var.auth;
    // Guests prove they booked it with the token from the booking response; an id alone is guessable.
    if (!auth && !validPaymentToken(appointmentId, paymentToken)) {
      throw new AppError(404, "NOT_FOUND", "Not found");
    }
    if (auth && auth.role === "customer") {
      const { findCustomer } = await import("../booking/customers");
      const { forTenant } = await import("../../db/scoped");
      const t = forTenant(c.var.tenant._id);
      const [customer, appointment] = await Promise.all([
        findCustomer(t, { userId: auth.userId }),
        t.appointments.findOne({ _id: appointmentId }),
      ]);
      if (
        !appointment ||
        !customer ||
        !appointment.customerId.equals(customer._id)
      ) {
        throw new AppError(404, "NOT_FOUND", "Not found");
      }
    }
    return c.json(await createPaymentIntent(c.var.tenant, appointmentId), 201);
  },
);

export const stripeWebhookRoutes = new Hono<Env>().post("/", async (c) => {
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new AppError(503, "PAYMENTS_DISABLED", "Webhooks are not configured");
  }
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    throw new AppError(400, "BAD_SIGNATURE", "Missing Stripe signature");
  }
  const payload = await c.req.text();
  const stripe = requireStripe();
  let event: Stripe.Event | undefined;
  try {
    event = await stripe.webhooks.constructEventAsync(
      payload,
      signature,
      config.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    // Not a v1 event: connected accounts speak thin events (v2).
  }
  if (event) {
    // Outside the try: a failing handler answers 500 (Stripe retries), not "bad signature".
    await handleStripeEvent(event);
    await handleBillingEvent(event);
    return c.json({ received: true });
  }
  try {
    const notification = await stripe.parseEventNotificationAsync(
      payload,
      signature,
      config.STRIPE_WEBHOOK_SECRET,
    );
    const related =
      "related_object" in notification &&
      notification.related_object &&
      "id" in notification.related_object
        ? (notification.related_object.id as string)
        : undefined;
    await handleThinNotification(notification.type, related);
    return c.json({ received: true });
  } catch {
    throw new AppError(400, "BAD_SIGNATURE", "Invalid Stripe signature");
  }
});
