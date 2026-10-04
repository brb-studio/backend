import { describe, expect, test } from "bun:test";
import { sessions, users } from "../src/db/collections";
import { api, createTenant, createUser, PASSWORD } from "./helpers";

const ana = {
  name: "Ana",
  email: "Ana@Example.com ",
  password: "s3cret-pass",
  phone: "+52 (664) 123-4567",
};

describe("register and login", () => {
  test("a customer registers, gets a session, and /me works", async () => {
    const { host } = await createTenant();
    const res = await api("POST", "/v1/auth/register", { host, body: ana });
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      name: "Ana",
      email: "ana@example.com",
      phone: "+526641234567",
      role: "customer",
      active: true,
    });
    expect(String(res.body.token)).toHaveLength(43);

    const me = await api("GET", "/v1/auth/me", {
      host,
      token: String(res.body.token),
    });
    expect(me.status).toBe(200);
    expect(me.body.user).toEqual(res.body.user);
  });

  test("registration cannot pick a role or a tenant", async () => {
    const { host } = await createTenant();
    for (const extra of [
      { role: "owner" },
      { tenantId: "65f000000000000000000000" },
    ]) {
      const res = await api("POST", "/v1/auth/register", {
        host,
        body: { ...ana, ...extra },
      });
      expect(res.status).toBe(422);
    }
  });

  test("an email is unique per tenant, not across tenants", async () => {
    const a = await createTenant();
    const b = await createTenant();
    expect(
      (await api("POST", "/v1/auth/register", { host: a.host, body: ana }))
        .status,
    ).toBe(201);
    const again = await api("POST", "/v1/auth/register", {
      host: a.host,
      body: { ...ana, email: "ANA@example.com" },
    });
    expect(again.status).toBe(409);
    expect(again.body.error?.code).toBe("EMAIL_TAKEN");
    expect(
      (await api("POST", "/v1/auth/register", { host: b.host, body: ana }))
        .status,
    ).toBe(201);
  });

  test("login ignores email case; wrong password and unknown email get the same 401", async () => {
    const { host } = await createTenant();
    await api("POST", "/v1/auth/register", { host, body: ana });

    const ok = await api("POST", "/v1/auth/login", {
      host,
      body: { email: "ANA@EXAMPLE.COM", password: ana.password },
    });
    expect(ok.status).toBe(200);
    expect(String(ok.body.token)).toHaveLength(43);

    const wrong = await api("POST", "/v1/auth/login", {
      host,
      body: { email: "ana@example.com", password: "nope-nope" },
    });
    const unknown = await api("POST", "/v1/auth/login", {
      host,
      body: { email: "nobody@example.com", password: "nope-nope" },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  test("tenant A's credentials do not work on tenant B", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const { user } = await createUser(a.tenant, "owner");
    const res = await api("POST", "/v1/auth/login", {
      host: b.host,
      body: { email: user.email, password: PASSWORD },
    });
    expect(res.status).toBe(401);
  });

  test("passwords and tokens are stored hashed and never returned", async () => {
    const { tenant, host } = await createTenant();
    const res = await api("POST", "/v1/auth/register", { host, body: ana });
    const token = String(res.body.token);

    const doc = await users.findOne({
      tenantId: tenant._id,
      email: "ana@example.com",
    });
    expect(doc?.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
    expect(JSON.stringify(res.body)).not.toContain(ana.password);
    expect(await sessions.findOne({ _id: token })).toBeNull();
    expect(await sessions.countDocuments({ userId: doc?._id })).toBe(1);
  });
});

describe("sessions", () => {
  test("logout revokes the token", async () => {
    const { tenant, host } = await createTenant();
    const { token } = await createUser(tenant, "customer");
    expect((await api("POST", "/v1/auth/logout", { host, token })).status).toBe(
      204,
    );
    expect((await api("GET", "/v1/auth/me", { host, token })).status).toBe(401);
  });

  test("an expired or deactivated session is anonymous: 401 on private routes, public still works", async () => {
    const { tenant, host } = await createTenant();
    const expired = await createUser(tenant, "customer");
    const inactive = await createUser(tenant, "customer");
    await sessions.updateMany(
      { userId: expired.user._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await users.updateOne(
      { _id: inactive.user._id },
      { $set: { active: false } },
    );

    for (const token of [expired.token, inactive.token, "garbage"]) {
      expect((await api("GET", "/v1/auth/me", { host, token })).status).toBe(
        401,
      );
      expect(
        (await api("GET", "/v1/public/tenant", { host, token })).status,
      ).toBe(200);
    }
  });

  test("a session past half its life is renewed to 30 days", async () => {
    const { tenant, host } = await createTenant();
    const { user, token } = await createUser(tenant, "customer");
    await sessions.updateOne(
      { userId: user._id },
      { $set: { expiresAt: new Date(Date.now() + 864e5) } },
    );
    await api("GET", "/v1/auth/me", { host, token });
    const session = await sessions.findOne({ userId: user._id });
    expect((session?.expiresAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      29 * 864e5,
    );
  });
});

test("login is rate limited per account: the 11th attempt in 15 min is 429", async () => {
  const { tenant, host } = await createTenant();
  const { user } = await createUser(tenant, "customer");
  for (let i = 0; i < 10; i++) {
    const res = await api("POST", "/v1/auth/login", {
      host,
      body: { email: user.email, password: "wrong-password" },
    });
    expect(res.status).toBe(401);
  }
  const blocked = await api("POST", "/v1/auth/login", {
    host,
    body: { email: user.email, password: PASSWORD },
  });
  expect(blocked.status).toBe(429);
});
