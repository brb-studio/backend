import { createHmac, timingSafeEqual } from "node:crypto";
import type { ObjectId } from "mongodb";
import { config } from "../../config";

const secret = () =>
  config.PAYMENT_TOKEN_SECRET ?? "development-only-payment-token-secret";

const tokenFor = (appointmentId: ObjectId) =>
  createHmac("sha256", secret())
    .update(`pay:${appointmentId.toHexString()}`)
    .digest();

/**
 * Proof of having booked an appointment, for guests (no session) who pay right after booking. An HMAC
 * of the id, so nothing is stored; ids alone are guessable (ObjectIds count up).
 */
export const paymentToken = (appointmentId: ObjectId) =>
  tokenFor(appointmentId).toString("base64url");

export function validPaymentToken(
  appointmentId: ObjectId,
  token: string | undefined,
) {
  if (!token) return false;
  const expected = tokenFor(appointmentId);
  const given = Buffer.from(token, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
