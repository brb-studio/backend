import { createHmac, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { config } from "../../config";

const secret = () =>
  config.PAYMENT_TOKEN_SECRET ?? "development-only-payment-token-secret";

const sign = (id: string) =>
  createHmac("sha256", secret())
    .update(`product-order:${id}`)
    .digest()
    .subarray(0, 16);

export const orderCode = (id: ObjectId) =>
  `${id.toHexString()}.${sign(id.toHexString()).toString("base64url")}`;

export function orderIdOf(code: string): ObjectId | undefined {
  const [id = "", mac = "", ...rest] = code.trim().split(".");
  if (rest.length > 0 || !/^[a-f\d]{24}$/.test(id)) return undefined;
  const expected = sign(id);
  const given = Buffer.from(mac, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? new ObjectId(id)
    : undefined;
}
