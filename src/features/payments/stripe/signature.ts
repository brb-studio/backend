import { createHmac, timingSafeEqual } from "node:crypto";

/** Stripe's documented default: a signature older than this is a replay, even if it is valid. */
export const TOLERANCE_SECONDS = 300;

export const signPayload = (payload: string, secret: string, t: number) =>
  createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

/**
 * Checks a `Stripe-Signature` header (`t=<unix>,v1=<hex>[,v1=…]`) against the raw body: HMAC-SHA256 of
 * `<t>.<body>` with any of the destinations' secrets, compared in constant time, within the tolerance.
 */
export function verifySignature(
  payload: string,
  header: string | undefined,
  secrets: string[],
  nowSeconds: number,
) {
  if (!header) return false;
  let timestamp: number | undefined;
  const signatures: Buffer[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === "v1" && value && /^[a-f\d]{64}$/.test(value)) {
      signatures.push(Buffer.from(value, "hex"));
    }
  }
  if (timestamp === undefined || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;
  const t = timestamp;
  return secrets.some((secret) => {
    const expected = Buffer.from(signPayload(payload, secret, t), "hex");
    return signatures.some((given) => timingSafeEqual(given, expected));
  });
}
