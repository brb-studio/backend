import { expect, test } from "bun:test";
import { rateLimits } from "../src/db/collections";
import { hit } from "../src/db/rate-limit";

test("concurrent attempts share one counter: exactly `limit` get through", async () => {
  const results = await Promise.all(
    Array.from({ length: 30 }, () => hit("race:ana@example.com", 20, 60_000)),
  );
  expect(results.filter(Boolean)).toHaveLength(20);
});

test("a window allows `limit` hits per key, then restarts once it expires", async () => {
  const t0 = new Date("2026-01-01T00:00:00Z");
  const at = (ms: number) => new Date(t0.getTime() + ms);
  expect(await hit("window:a", 2, 1_000, t0)).toBe(true);
  expect(await hit("window:a", 2, 1_000, at(10))).toBe(true);
  expect(await hit("window:a", 2, 1_000, at(20))).toBe(false);
  expect(await hit("window:b", 2, 1_000, at(20))).toBe(true);
  expect(await hit("window:a", 2, 1_000, at(1_000))).toBe(true);
});

test("keys are stored hashed and expire through the TTL index", async () => {
  await hit("login:tenant:secret@example.com", 10, 60_000);
  const docs = await rateLimits.find().toArray();
  expect(JSON.stringify(docs)).not.toContain("secret@example.com");
  const indexes = await rateLimits.indexes();
  expect(indexes).toContainEqual(
    expect.objectContaining({ name: "expiresAt_ttl", expireAfterSeconds: 0 }),
  );
});
