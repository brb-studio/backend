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
      .default("magicstudio"),
    PLATFORM_DOMAIN: z
      .string()
      .regex(/^[a-z0-9]+([.-][a-z0-9]+)*$/)
      .default("localhost"),
    PROXY_SECRET: z.string().min(32, "use at least 32 characters").optional(),
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
