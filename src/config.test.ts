import { describe, expect, test } from "bun:test";
import { parseConfig } from "./config";

const local = { MONGO_URL: "mongodb://127.0.0.1:27017/?replicaSet=rs0" };

const errorOf = (env: Record<string, string>) => {
  try {
    parseConfig(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseConfig to throw");
};

describe("parseConfig", () => {
  test("applies defaults", () => {
    expect(parseConfig(local)).toEqual({
      NODE_ENV: "development",
      PORT: 4000,
      MONGO_URL: local.MONGO_URL,
      MONGO_DB: "brb-studio",
      PLATFORM_DOMAIN: "localhost",
      CORS_ORIGINS: "",
      SUBSCRIPTION_PRICE_MINOR: 30_000,
      SUBSCRIPTION_CURRENCY: "MXN",
      STRIPE_CARD_FEE_BPS: 360,
      STRIPE_CARD_FEE_FIXED_MINOR: 300,
      STRIPE_CARD_FEE_FIXED_MINOR_USD: 20,
      STRIPE_INTL_CARD_FEE_BPS: 50,
      STRIPE_FX_FEE_BPS: 200,
      STRIPE_TRANSFER_FEE_BPS: 0,
      STRIPE_TRANSFER_FEE_FIXED_MINOR: 700,
      STRIPE_FEE_TAX_BPS: 1600,
      PAYMENT_HOLD_CARD_MIN: 20,
      PAYMENT_HOLD_TRANSFER_MIN: 60,
    });
  });

  test("Stripe: test keys outside production, live keys in it, always with a webhook secret", () => {
    const stripe = {
      STRIPE_SECRET_KEY: "rk_test_abc123",
      STRIPE_WEBHOOK_SECRET: "whsec_one,whsec_two",
    };
    expect(parseConfig({ ...local, ...stripe }).STRIPE_WEBHOOK_SECRET).toEqual([
      "whsec_one",
      "whsec_two",
    ]);
    expect(
      errorOf({ ...local, ...stripe, STRIPE_SECRET_KEY: "sk_live_abc123" }),
    ).toContain("STRIPE_SECRET_KEY");
    expect(
      errorOf({ ...local, STRIPE_SECRET_KEY: stripe.STRIPE_SECRET_KEY }),
    ).toContain("STRIPE_WEBHOOK_SECRET");
    expect(errorOf({ ...local, STRIPE_SECRET_KEY: "pk_test_abc" })).toContain(
      "STRIPE_SECRET_KEY",
    );
    const production = {
      ...local,
      ...stripe,
      NODE_ENV: "production",
      PROXY_SECRET: "x".repeat(32),
      PAYMENT_TOKEN_SECRET: "y".repeat(32),
    };
    expect(errorOf(production)).toContain("STRIPE_SECRET_KEY");
    expect(
      parseConfig({ ...production, STRIPE_SECRET_KEY: "sk_live_abc" })
        .STRIPE_SECRET_KEY,
    ).toBe("sk_live_abc");
  });

  test("MAIL_FROM: a plain address or Name <address>, set together with the key", () => {
    const key = { RESEND_API_KEY: "re_1234567890" };
    for (const from of [
      "onboarding@resend.dev",
      "brb-studio <no-reply@a.com>",
    ]) {
      expect(parseConfig({ ...local, ...key, MAIL_FROM: from }).MAIL_FROM).toBe(
        from,
      );
    }
    expect(
      errorOf({ ...local, ...key, MAIL_FROM: "onboarding@resend.dev." }),
    ).toContain("MAIL_FROM");
    expect(errorOf({ ...local, ...key })).toContain("MAIL_FROM");
  });

  test("accepts every localhost form", () => {
    for (const hosts of [
      "localhost",
      "127.0.0.1:27017",
      "[::1]:27017",
      "localhost:27017,127.0.0.1:27018",
    ]) {
      expect(parseConfig({ MONGO_URL: `mongodb://${hosts}/` }).MONGO_URL).toBe(
        `mongodb://${hosts}/`,
      );
    }
  });

  test("refuses any other host outside production, without echoing the URL", () => {
    for (const url of [
      "mongodb+srv://ana:s3cret@cluster0.abc.mongodb.net/",
      "mongodb://ana:s3cret@10.0.0.5:27017/",
      "mongodb://localhost:27017,db.example.com:27017/",
      "mongodb://localhost.example.com/",
      "mongodb://localhost@example.com/",
    ]) {
      const message = errorOf({ MONGO_URL: url });
      expect(message).toContain("MONGO_URL: only localhost");
      expect(message).not.toContain("s3cret");
    }
  });

  test("allows a remote host in production", () => {
    const url = "mongodb+srv://ana:s3cret@cluster0.abc.mongodb.net/";
    const secret = "s".repeat(32);
    expect(
      parseConfig({
        NODE_ENV: "production",
        MONGO_URL: url,
        PROXY_SECRET: secret,
        PAYMENT_TOKEN_SECRET: secret,
      }).MONGO_URL,
    ).toBe(url);
    expect(errorOf({ NODE_ENV: "production", MONGO_URL: url })).toContain(
      "PROXY_SECRET: required in production",
    );
    expect(
      errorOf({ NODE_ENV: "production", MONGO_URL: url, PROXY_SECRET: secret }),
    ).toContain("PAYMENT_TOKEN_SECRET: required in production");
  });

  test("tests can only use a *_test database", () => {
    expect(
      errorOf({ NODE_ENV: "test", ...local, MONGO_DB: "brb-studio" }),
    ).toContain("MONGO_DB: tests must use a *_test database");
  });

  test("rejects a missing or non-MongoDB URL", () => {
    expect(errorOf({})).toContain("MONGO_URL");
    expect(errorOf({ MONGO_URL: "postgres://localhost/db" })).toContain(
      "MONGO_URL: must be a mongodb:// URL",
    );
  });
});
