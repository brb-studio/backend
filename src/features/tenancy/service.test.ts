import { describe, expect, test } from "bun:test";
import { tenantQuery } from "./service";
import { isSubscriptionActive, PLAN_LIMITS } from "./subscription";

describe("tenantQuery", () => {
  test("subdomain of the platform domain → slug, ignoring port, case and trailing dot", () => {
    expect(tenantQuery("MagicStudio.localhost:3000", "localhost")).toEqual({
      slug: "magicstudio",
    });
    expect(
      tenantQuery("barberia-juan.magicstudio.app.", "magicstudio.app"),
    ).toEqual({
      slug: "barberia-juan",
    });
    expect(tenantQuery("a.example.com, proxy.internal", "localhost")).toEqual({
      customDomain: "a.example.com",
    });
  });

  test("any other host → custom domain", () => {
    expect(tenantQuery("www.barberiajuan.com", "magicstudio.app")).toEqual({
      customDomain: "www.barberiajuan.com",
    });
  });

  test("bare platform domain, nested subdomains and junk resolve to nothing", () => {
    for (const host of [
      undefined,
      "",
      "localhost:4000",
      "a.b.localhost",
      "evil.com/x",
      "[::1]:3000",
    ]) {
      expect(tenantQuery(host, "localhost")).toBeNull();
    }
  });
});

describe("isSubscriptionActive", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 864e5);
  const sub = (
    status: "trialing" | "active" | "past_due" | "canceled",
    currentPeriodEnd?: Date,
  ) => ({
    plan: "basic" as const,
    status,
    limits: PLAN_LIMITS.basic,
    ...(currentPeriodEnd && { currentPeriodEnd }),
  });

  test("lifetime (no period end) stays active; canceled never is", () => {
    expect(isSubscriptionActive(sub("active"), now)).toBe(true);
    expect(isSubscriptionActive(sub("canceled"), now)).toBe(false);
  });

  test("an ended period keeps a 7-day grace", () => {
    expect(isSubscriptionActive(sub("past_due", daysAgo(6)), now)).toBe(true);
    expect(isSubscriptionActive(sub("trialing", daysAgo(8)), now)).toBe(false);
  });
});
