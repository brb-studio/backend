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
      MONGO_DB: "magicstudio",
      PLATFORM_DOMAIN: "localhost",
    });
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
      }).MONGO_URL,
    ).toBe(url);
    expect(errorOf({ NODE_ENV: "production", MONGO_URL: url })).toContain(
      "PROXY_SECRET: required in production",
    );
  });

  test("tests can only use a *_test database", () => {
    expect(
      errorOf({ NODE_ENV: "test", ...local, MONGO_DB: "magicstudio" }),
    ).toContain("MONGO_DB: tests must use a *_test database");
  });

  test("rejects a missing or non-MongoDB URL", () => {
    expect(errorOf({})).toContain("MONGO_URL");
    expect(errorOf({ MONGO_URL: "postgres://localhost/db" })).toContain(
      "MONGO_URL: must be a mongodb:// URL",
    );
  });
});
