import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { MongoNetworkError, MongoServerError } from "mongodb";
import * as z from "zod";
import { AppError, clientIp, type Env, notFound, onError, parse } from "./http";

const app = new Hono<Env>()
  .use(requestId())
  .get("/app-error", () => {
    throw new AppError(409, "SLOT_TAKEN", "Slot taken");
  })
  .get("/invalid", (c) =>
    c.json(parse(z.object({ n: z.number() }), { n: "x" })),
  )
  .get("/duplicate", () => {
    throw new MongoServerError({
      code: 11000,
      errmsg: 'E11000 duplicate key { email: "ana@example.com" }',
    });
  })
  .get("/db-down", () => {
    throw new MongoNetworkError("connect ECONNREFUSED 127.0.0.1:27017");
  })
  .get("/bug", () => {
    throw new Error("secret internal detail");
  })
  .notFound(notFound)
  .onError(onError);

const call = async (path: string) => {
  const res = await app.request(path);
  return {
    status: res.status,
    text: await res.text(),
    id: res.headers.get("X-Request-Id"),
  };
};

const logged = spyOn(console, "error").mockImplementation(() => {});
afterEach(() => logged.mockClear());

describe("onError", () => {
  test("AppError keeps its status, code and message", async () => {
    const res = await call("/app-error");
    expect(res.status).toBe(409);
    expect(JSON.parse(res.text)).toEqual({
      error: { code: "SLOT_TAKEN", message: "Slot taken" },
    });
    expect(res.id).toBeTruthy();
  });

  test("validation failures are 422 with field issues", async () => {
    const res = await call("/invalid");
    expect(res.status).toBe(422);
    expect(JSON.parse(res.text)).toEqual({
      error: {
        code: "VALIDATION",
        message: "Invalid request",
        issues: [{ path: "n", message: expect.any(String) }],
      },
    });
  });

  test("duplicate key is 409 without the duplicated value", async () => {
    const res = await call("/duplicate");
    expect(res.status).toBe(409);
    expect(JSON.parse(res.text).error.code).toBe("CONFLICT");
    expect(res.text).not.toContain("ana@example.com");
  });

  test("database unreachable is 503", async () => {
    const res = await call("/db-down");
    expect(res.status).toBe(503);
    expect(JSON.parse(res.text).error.code).toBe("UNAVAILABLE");
  });

  test("unexpected errors are a generic 500, detail only in the log", async () => {
    const res = await call("/bug");
    expect(res.status).toBe(500);
    expect(JSON.parse(res.text)).toEqual({
      error: { code: "INTERNAL", message: "Internal error" },
    });
    expect(res.text).not.toContain("secret internal detail");
    expect(res.text).not.toContain("at ");
    const line = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      requestId: res.id,
      message: "secret internal detail",
    });
  });

  test("unknown routes are 404 JSON", async () => {
    const res = await call("/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text).error.code).toBe("NOT_FOUND");
  });
});

describe("clientIp", () => {
  const secret = "s".repeat(32);
  const ipApp = new Hono()
    .get("/with-secret", (c) => c.text(clientIp(c, secret)))
    .get("/no-secret", (c) => c.text(clientIp(c, undefined)));
  const ip = async (path: string, headers: Record<string, string>) =>
    (await ipApp.request(path, { headers })).text();
  const forwarded = { "X-Forwarded-For": "6.6.6.6, 203.0.113.7" };

  test("trusts the forwarded IP only from the frontend server (shared secret)", async () => {
    expect(
      await ip("/with-secret", { ...forwarded, "X-Proxy-Secret": secret }),
    ).toBe("203.0.113.7");
  });

  test("ignores a forged X-Forwarded-For", async () => {
    expect(await ip("/with-secret", forwarded)).toBe("unknown");
    expect(
      await ip("/with-secret", { ...forwarded, "X-Proxy-Secret": "guess" }),
    ).toBe("unknown");
    expect(
      await ip("/no-secret", { ...forwarded, "X-Proxy-Secret": secret }),
    ).toBe("unknown");
  });
});
