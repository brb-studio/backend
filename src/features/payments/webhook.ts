import { Hono } from "hono";
import { config } from "../../config";
import { stripeEventLog } from "../../db/scoped";
import { AppError, type Env, isDuplicate } from "../../shared/http";
import { syncAccount } from "./connect";
import { onChargeRefunded, onDispute, onIntentEvent } from "./settle";
import { StripeError } from "./stripe/client";
import { verifySignature } from "./stripe/signature";
import { event as eventSchema } from "./stripe/types";

/** Stripe's events are small; anything bigger is not from Stripe. */
const BODY_LIMIT = 512 * 1024;

const INTENT_EVENTS = new Set([
  "payment_intent.succeeded",
  "payment_intent.requires_action",
  "payment_intent.partially_funded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);

const idOf = (object: unknown) =>
  typeof object === "object" &&
  object !== null &&
  "id" in object &&
  typeof object.id === "string"
    ? object.id
    : undefined;

async function dispatch(event: ReturnType<typeof eventSchema.parse>) {
  if (event.object === "v2.core.event") {
    // Accounts v2 send thin events: only the account id; its state is read from Stripe.
    const accountId = event.related_object?.id;
    if (event.type.startsWith("v2.core.account") && accountId) {
      await syncAccount(accountId);
    }
    return;
  }
  const object = event.data.object;
  const id = idOf(object);
  if (!id) return;
  if (INTENT_EVENTS.has(event.type)) return void (await onIntentEvent(id));
  if (event.type === "charge.refunded") return onChargeRefunded(object);
  if (event.type === "charge.dispute.created") return onDispute(object);
  if (event.type === "account.updated") return void (await syncAccount(id));
  if (event.type === "cash_balance.funds_available") {
    // Money that reached a customer's Stripe balance without an open payment (late or extra
    // transfer). Stripe applies it to their next payment; anything else is reviewed by hand.
    console.error(
      JSON.stringify({
        level: "warn",
        event: "stripe_unapplied_funds",
        customer: id,
      }),
    );
  }
}

/** Failures worth a retry: our database or Stripe being unreachable. A bad request stays failed. */
const transient = (err: unknown) =>
  !(err instanceof AppError && err.status < 500) &&
  !(err instanceof StripeError && err.status >= 400 && err.status < 500);

export const stripeWebhookRoutes = new Hono<Env>().post(
  "/stripe",
  async (c) => {
    const secrets = config.STRIPE_WEBHOOK_SECRET;
    if (!secrets) throw new AppError(404, "NOT_FOUND", "Not found");
    const payload = await c.req.text();
    if (payload.length > BODY_LIMIT) {
      throw new AppError(413, "TOO_LARGE", "Body is too large");
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !verifySignature(payload, c.req.header("Stripe-Signature"), secrets, now)
    ) {
      throw new AppError(400, "BAD_SIGNATURE", "Invalid signature");
    }
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      throw new AppError(400, "BAD_JSON", "Body must be valid JSON");
    }
    const parsed = eventSchema.safeParse(data);
    if (!parsed.success) return c.json({ received: true });
    const event = parsed.data;
    if (await stripeEventLog.findOne({ _id: event.id })) {
      return c.json({ received: true, duplicate: true });
    }
    try {
      await dispatch(event);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "stripe_webhook_failed",
          type: event.type,
          id: event.id,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      if (transient(err)) {
        throw new AppError(500, "WEBHOOK_RETRY", "Try again later");
      }
    }
    await stripeEventLog
      .insertOne({ _id: event.id, type: event.type, receivedAt: new Date() })
      .catch((err: unknown) => {
        if (!isDuplicate(err)) throw err;
      });
    return c.json({ received: true });
  },
);
