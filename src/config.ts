import * as z from "zod";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const mongoHosts = (url: string) =>
  url
    .replace(/^mongodb(\+srv)?:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .split(/[/?]/)[0]
    ?.split(",") ?? [];

const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGO_URL: z
      .string()
      .regex(/^mongodb(\+srv)?:\/\/./, "must be a mongodb:// URL"),
    MONGO_DB: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,63}$/)
      .default("brb-studio"),
    PLATFORM_DOMAIN: z
      .string()
      .regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/)
      .default("localhost"),
    PROXY_SECRET: z.string().min(32, "use at least 32 characters").optional(),
    /** Lets a scheduler (Vercel Cron, any pinger) call `GET /cron/digest`; without it the route is off. */
    CRON_SECRET: z.string().min(32, "use at least 32 characters").optional(),
    FRONTEND_URL: z.url().optional(),
    CORS_ORIGINS: z.string().default(""),
    /** Signs the proof of booking guests use to ask for transfer details. */
    PAYMENT_TOKEN_SECRET: z
      .string()
      .min(32, "use at least 32 characters")
      .optional(),
    /** The one monthly price barbershops pay for the app, in minor units (30000 = 300.00). */
    SUBSCRIPTION_PRICE_MINOR: z.coerce.number().int().min(1).default(30_000),
    SUBSCRIPTION_CURRENCY: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("MXN"),
    /**
     * Platform key for card and bank-transfer payments through Stripe Connect. Without it (and the webhook
     * secret) online payments stay off and every barbershop uses manual SPEI transfers. A restricted key
     * (`rk_`) is preferred.
     */
    STRIPE_SECRET_KEY: z
      .string()
      .regex(
        /^(sk|rk)_(test|live)_\w+$/,
        "must be a Stripe secret or restricted key",
      )
      .optional(),
    /** Signing secrets of the webhook destinations (`whsec_…`), comma separated: one per destination. */
    STRIPE_WEBHOOK_SECRET: z
      .string()
      .regex(/^whsec_\w+(,whsec_\w+)*$/, "comma-separated whsec_ secrets")
      .transform((value) => value.split(","))
      .optional(),
    /** Fee the platform keeps from each payment to cover Stripe's: basis points + fixed, plus tax on it. */
    STRIPE_CARD_FEE_BPS: z.coerce.number().int().min(0).max(2000).default(360),
    STRIPE_CARD_FEE_FIXED_MINOR: z.coerce.number().int().min(0).default(300),
    /** Fixed part of the card fee for dollar charges, in cents (about MXN 3.00). */
    STRIPE_CARD_FEE_FIXED_MINOR_USD: z.coerce.number().int().min(0).default(20),
    /** Stripe's surcharges: foreign cards and currency conversion (dollar charges settle in pesos). */
    STRIPE_INTL_CARD_FEE_BPS: z.coerce
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(50),
    STRIPE_FX_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(200),
    STRIPE_TRANSFER_FEE_BPS: z.coerce
      .number()
      .int()
      .min(0)
      .max(2000)
      .default(0),
    STRIPE_TRANSFER_FEE_FIXED_MINOR: z.coerce
      .number()
      .int()
      .min(0)
      .default(700),
    STRIPE_FEE_TAX_BPS: z.coerce.number().int().min(0).max(5000).default(1600),
    /** Minutes a slot stays held while the customer pays online. */
    PAYMENT_HOLD_CARD_MIN: z.coerce.number().int().min(5).max(120).default(20),
    PAYMENT_HOLD_TRANSFER_MIN: z.coerce
      .number()
      .int()
      .min(15)
      .max(24 * 60)
      .default(60),
    /** Transactional email (verification and password reset) through Resend. Both or neither. */
    RESEND_API_KEY: z.string().min(10).optional(),
    MAIL_FROM: z
      .string()
      .regex(
        /^([^<>"]+ <)?[^\s<>@]+@[^\s<>@.]+(\.[^\s<>@.]+)+>?$/,
        'must be "email@example.com" or "Name <email@example.com>"',
      )
      .optional(),
    VAPID_PUBLIC_KEY: z
      .string()
      .regex(/^[\w-]{87}$/)
      .optional(),
    VAPID_PRIVATE_KEY: z
      .string()
      .regex(/^[\w-]{43}$/)
      .optional(),
    VAPID_SUBJECT: z
      .string()
      .regex(/^(mailto:|https:\/\/)/)
      .optional(),
  })
  .refine(
    (env) =>
      env.NODE_ENV === "production" ||
      mongoHosts(env.MONGO_URL).every((host) => LOCAL_HOST.test(host)),
    {
      path: ["MONGO_URL"],
      error: "only localhost is allowed outside production",
    },
  )
  .refine((env) => env.NODE_ENV !== "production" || env.PROXY_SECRET, {
    path: ["PROXY_SECRET"],
    error: "required in production, or every visitor shares one rate limit",
  })
  .refine((env) => env.NODE_ENV !== "production" || env.PAYMENT_TOKEN_SECRET, {
    path: ["PAYMENT_TOKEN_SECRET"],
    error: "required in production, or guests cannot pay by transfer",
  })
  .refine(
    (env) =>
      !env.STRIPE_SECRET_KEY ||
      env.STRIPE_SECRET_KEY.includes(
        env.NODE_ENV === "production" ? "_live_" : "_test_",
      ),
    {
      path: ["STRIPE_SECRET_KEY"],
      error: "use a live key in production and a test key everywhere else",
    },
  )
  .refine((env) => !env.STRIPE_SECRET_KEY === !env.STRIPE_WEBHOOK_SECRET, {
    path: ["STRIPE_WEBHOOK_SECRET"],
    error:
      "set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET together, or neither",
  })
  .refine((env) => !env.RESEND_API_KEY === !env.MAIL_FROM, {
    path: ["MAIL_FROM"],
    error: "set RESEND_API_KEY and MAIL_FROM together, or neither",
  })
  .refine((env) => env.NODE_ENV !== "test" || env.MONGO_DB.endsWith("_test"), {
    path: ["MONGO_DB"],
    error: "tests must use a *_test database",
  })
  .refine(
    (env) =>
      [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].every(
        Boolean,
      ) ||
      [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT].every(
        (v) => !v,
      ),
    {
      path: ["VAPID_PUBLIC_KEY"],
      error: "set all three VAPID_* variables, or none",
    },
  );

export type Config = z.output<typeof schema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const issues = result.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid environment:\n  ${issues.join("\n  ")}`);
}

export const config = parseConfig(process.env);
