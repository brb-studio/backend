import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { branches, tenants } from "../src/db/collections";
import { PLAN_LIMITS } from "../src/features/tenancy/subscription";
import { api, branchInput, createTenant, createUser } from "./helpers";

const daysAgo = (days: number) => new Date(Date.now() - days * 864e5);

describe("tenant resolution", () => {
  test("an unknown host is 404 TENANT_NOT_FOUND", async () => {
    const res = await api("GET", "/v1/public/tenant", {
      host: "nobody.localhost",
    });
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("TENANT_NOT_FOUND");
  });

  test("public tenant: branding and active branches only, no internal fields", async () => {
    const { tenant, host } = await createTenant({
      theme: { accent: "#2563eb" },
    });
    const { token } = await createUser(tenant, "owner");
    await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput({ slug: "centro" }),
    });
    const closed = await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput({ slug: "norte" }),
    });
    await api("PATCH", `/v1/branches/${closed.body.id}`, {
      host,
      token,
      body: { active: false },
    });

    const res = await api("GET", "/v1/public/tenant", { host });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: tenant.slug,
      currency: "MXN",
      theme: { accent: "#2563eb" },
    });
    expect(
      (res.body.branches as { slug: string }[]).map((b) => b.slug),
    ).toEqual(["centro"]);
    const json = JSON.stringify(res.body);
    for (const leak of [
      "subscription",
      "tenantId",
      tenant._id.toHexString(),
      "active",
    ]) {
      expect(json).not.toContain(leak);
    }
  });

  test("a custom domain resolves to its tenant", async () => {
    const domain = `barberia-${new ObjectId().toHexString()}.example.com`;
    const { tenant } = await createTenant({ customDomain: domain });
    const res = await api("GET", "/v1/public/tenant", {
      host: `${domain.toUpperCase()}:443`,
    });
    expect(res.body.slug).toBe(tenant.slug);
  });
});

describe("branches", () => {
  test("the owner creates a branch with default booking rules and a split shift", async () => {
    const { tenant, host } = await createTenant();
    const { token } = await createUser(tenant, "owner");
    const res = await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput(),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      timeZone: "America/Tijuana",
      active: true,
      booking: {
        slotIntervalMin: 15,
        bufferMin: 0,
        minNoticeMin: 60,
        windowDays: 14,
        cancelNoticeMin: 120,
      },
    });
    expect(res.body.hours).toHaveLength(2);
    const list = await api("GET", "/v1/branches", { host, token });
    expect((list.body as unknown as { id: string }[]).map((b) => b.id)).toEqual(
      [String(res.body.id)],
    );
  });

  test("422 for a bad time zone, inverted or overlapping hours, or a tenantId in the body", async () => {
    const { tenant, host } = await createTenant();
    const other = await createTenant();
    const { token } = await createUser(tenant, "owner");
    for (const body of [
      branchInput({ timeZone: "Mars/Olympus" }),
      branchInput({ hours: [{ weekday: 1, open: "18:00", close: "10:00" }] }),
      branchInput({
        hours: [
          { weekday: 1, open: "09:00", close: "14:00" },
          { weekday: 1, open: "13:00", close: "20:00" },
        ],
      }),
      { ...branchInput(), tenantId: other.tenant._id.toHexString() },
    ]) {
      expect(
        (await api("POST", "/v1/branches", { host, token, body })).status,
      ).toBe(422);
    }
    expect(await branches.countDocuments({ tenantId: other.tenant._id })).toBe(
      0,
    );
  });

  test("a duplicate slug is 409 SLUG_TAKEN", async () => {
    const { tenant, host } = await createTenant();
    const { token } = await createUser(tenant, "owner");
    await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput({ slug: "centro" }),
    });
    const res = await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput({ slug: "centro" }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("SLUG_TAKEN");
  });

  test("PATCH booking rules is partial", async () => {
    const { tenant, host } = await createTenant();
    const { token } = await createUser(tenant, "owner");
    const created = await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput({ booking: { bufferMin: 10 } }),
    });
    const res = await api("PATCH", `/v1/branches/${created.body.id}`, {
      host,
      token,
      body: { booking: { slotIntervalMin: 30 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.booking).toEqual({
      slotIntervalMin: 30,
      bufferMin: 10,
      minNoticeMin: 60,
      windowDays: 14,
      cancelNoticeMin: 120,
    });
  });

  test("the plan's branch limit counts active branches", async () => {
    const { tenant, host } = await createTenant({
      subscription: {
        plan: "basic",
        status: "active",
        limits: PLAN_LIMITS.basic,
      },
    });
    const { token } = await createUser(tenant, "owner");
    const first = await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput(),
    });
    expect(first.status).toBe(201);

    const over = await api("POST", "/v1/branches", {
      host,
      token,
      body: branchInput(),
    });
    expect(over.status).toBe(402);
    expect(over.body.error?.code).toBe("PLAN_LIMIT");

    await api("PATCH", `/v1/branches/${first.body.id}`, {
      host,
      token,
      body: { active: false },
    });
    expect(
      (await api("POST", "/v1/branches", { host, token, body: branchInput() }))
        .status,
    ).toBe(201);
    const reactivate = await api("PATCH", `/v1/branches/${first.body.id}`, {
      host,
      token,
      body: { active: true },
    });
    expect(reactivate.status).toBe(402);
  });

  test("an inactive subscription blocks writes but not reads", async () => {
    for (const [subscription, allowed] of [
      [{ plan: "pro", status: "canceled", limits: PLAN_LIMITS.pro }, false],
      [
        {
          plan: "pro",
          status: "past_due",
          currentPeriodEnd: daysAgo(8),
          limits: PLAN_LIMITS.pro,
        },
        false,
      ],
      [
        {
          plan: "pro",
          status: "past_due",
          currentPeriodEnd: daysAgo(6),
          limits: PLAN_LIMITS.pro,
        },
        true,
      ],
    ] as const) {
      const { tenant, host } = await createTenant({
        subscription: { ...subscription },
      });
      const { token } = await createUser(tenant, "owner");
      const write = await api("POST", "/v1/branches", {
        host,
        token,
        body: branchInput(),
      });
      expect(write.status).toBe(allowed ? 201 : 402);
      if (!allowed)
        expect(write.body.error?.code).toBe("SUBSCRIPTION_INACTIVE");
      expect((await api("GET", "/v1/branches", { host, token })).status).toBe(
        200,
      );
    }
  });
});

describe("tenant isolation", () => {
  test("tenant A cannot read or modify tenant B's branches", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const ownerA = await createUser(a.tenant, "owner");
    const ownerB = await createUser(b.tenant, "owner");
    const branchB = await api("POST", "/v1/branches", {
      host: b.host,
      token: ownerB.token,
      body: branchInput({ name: "Solo de B" }),
    });
    const asA = { host: a.host, token: ownerA.token };

    expect(
      (await api("GET", `/v1/branches/${branchB.body.id}`, asA)).status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/v1/branches/${branchB.body.id}`, {
          ...asA,
          body: { name: "hacked" },
        })
      ).status,
    ).toBe(404);
    expect((await api("GET", "/v1/branches", asA)).body).toEqual(
      [] as unknown as typeof asA,
    );

    const still = await api("GET", `/v1/branches/${branchB.body.id}`, {
      host: b.host,
      token: ownerB.token,
    });
    expect(still.body.name).toBe("Solo de B");
  });

  test("a session only works on its own tenant's host", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const ownerA = await createUser(a.tenant, "owner");
    expect(
      (await api("GET", "/v1/branches", { host: b.host, token: ownerA.token }))
        .status,
    ).toBe(401);
  });
});

describe("branch authorization", () => {
  test("a manager sees and edits only their own branch, and cannot open or close branches", async () => {
    const { tenant, host } = await createTenant();
    const owner = await createUser(tenant, "owner");
    const mine = await api("POST", "/v1/branches", {
      host,
      token: owner.token,
      body: branchInput(),
    });
    const other = await api("POST", "/v1/branches", {
      host,
      token: owner.token,
      body: branchInput(),
    });
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(String(mine.body.id)),
    });
    const asManager = { host, token: manager.token };

    const list = await api("GET", "/v1/branches", asManager);
    expect((list.body as unknown as { id: string }[]).map((b) => b.id)).toEqual(
      [String(mine.body.id)],
    );
    expect(
      (await api("GET", `/v1/branches/${other.body.id}`, asManager)).status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/v1/branches/${other.body.id}`, {
          ...asManager,
          body: { name: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api("PATCH", `/v1/branches/${mine.body.id}`, {
          ...asManager,
          body: { name: "Centro 2" },
        })
      ).body.name,
    ).toBe("Centro 2");
    expect(
      (
        await api("PATCH", `/v1/branches/${mine.body.id}`, {
          ...asManager,
          body: { active: false },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("POST", "/v1/branches", { ...asManager, body: branchInput() }))
        .status,
    ).toBe(403);
  });

  test("customers get 403 and anonymous callers 401 on staff routes", async () => {
    const { tenant, host } = await createTenant();
    const customer = await createUser(tenant, "customer");
    expect(
      (await api("GET", "/v1/branches", { host, token: customer.token }))
        .status,
    ).toBe(403);
    expect((await api("GET", "/v1/branches", { host })).status).toBe(401);
  });
});

describe("tenant settings", () => {
  test("the owner edits name, brand and theme; a manager cannot", async () => {
    const { tenant, host } = await createTenant();
    const owner = await createUser(tenant, "owner");
    const manager = await createUser(tenant, "manager");
    const theme = { accent: { light: "#1d4ed8", dark: "#60a5fa" } };

    const res = await api("PATCH", "/v1/tenant", {
      host,
      token: owner.token,
      body: {
        name: "Barbería Juan",
        theme,
        brand: { instagramUrl: "https://instagram.com/juan" },
      },
    });
    expect(res.status).toBe(200);
    expect(
      (await api("GET", "/v1/public/tenant", { host })).body,
    ).toMatchObject({ name: "Barbería Juan", theme });

    expect(
      (
        await api("PATCH", "/v1/tenant", {
          host,
          token: owner.token,
          body: { theme: { accent: "red;}" } },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api("PATCH", "/v1/tenant", {
          host,
          token: owner.token,
          body: { currency: "USD" },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await api("PATCH", "/v1/tenant", {
          host,
          token: manager.token,
          body: { name: "x" },
        })
      ).status,
    ).toBe(403);
    expect((await tenants.findOne({ _id: tenant._id }))?.currency).toBe("MXN");
  });
});
