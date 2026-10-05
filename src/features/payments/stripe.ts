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
