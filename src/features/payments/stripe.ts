import { createHmac, timingSafeEqual } from "node:crypto";
import type { ObjectId } from "mongodb";
import Stripe from "stripe";
import { config } from "../../config";
import { AppError } from "../../shared/http";

let cached: Stripe | null = null;

export const paymentsEnabled = () =>
  Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET);

export function requireStripe(): Stripe {
  if (!config.STRIPE_SECRET_KEY) {
    throw new AppError(
      503,
      "PAYMENTS_DISABLED",
      "Stripe is not configured on this server",
    );
  }
  cached ??= new Stripe(config.STRIPE_SECRET_KEY, {
    appInfo: { name: "magicstudio-backend" },
  });
  return cached;
}

const tokenFor = (secret: string, appointmentId: ObjectId) =>
  createHmac("sha256", secret)
    .update(`pay:${appointmentId.toHexString()}`)
    .digest();

/**
 * Proof of having booked an appointment, for guests (no session) who pay right after booking. An HMAC
 * of the id, so nothing is stored; ids alone are guessable (ObjectIds count up).
 */
export function paymentToken(appointmentId: ObjectId) {
  if (!config.STRIPE_SECRET_KEY) return undefined;
  return tokenFor(config.STRIPE_SECRET_KEY, appointmentId).toString(
    "base64url",
  );
}

export function validPaymentToken(
  appointmentId: ObjectId,
  token: string | undefined,
) {
  if (!config.STRIPE_SECRET_KEY || !token) return false;
  const expected = tokenFor(config.STRIPE_SECRET_KEY, appointmentId);
  const given = Buffer.from(token, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
