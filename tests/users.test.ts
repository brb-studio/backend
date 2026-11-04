import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import {
  addBranch,
  api,
  createShop,
  createTenant,
  createUser,
  PASSWORD,
} from "./helpers";

describe("staff accounts", () => {
  test("the owner creates a manager, who signs in with the one-time password", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    await createUser(tenant, "customer");
    const res = await api("POST", "/v1/users", {
      ...asOwner,
      body: {
        name: "Lucía",
        email: "Lucia@Example.com",
        role: "manager",
        branchId,
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: "lucia@example.com",
      role: "manager",
      branchId,
      active: true,
    });
    const temporary = String(res.body.temporaryPassword);
    expect(temporary.length).toBeGreaterThanOrEqual(16);

    const login = await api("POST", "/v1/auth/login", {
      host,
      body: { email: "lucia@example.com", password: temporary },
    });
    expect(login.status).toBe(200);

    const list = await api("GET", "/v1/users", asOwner);
    const roles = (list.body as unknown as { role: string }[])
      .map((u) => u.role)
      .sort();
    expect(roles).toEqual(["manager", "owner"]);
  });

  test("role and branch must fit together and belong to this tenant", async () => {
    const { branchId, asOwner } = await createShop();
    const other = await createShop();
    const user = { name: "Ana López", email: "ana@example.com" };
    for (const [body, status] of [
      [{ ...user, role: "manager" }, 422],
      [{ ...user, role: "admin", branchId }, 422],
      [{ ...user, role: "owner" }, 422],
      [{ ...user, role: "customer", branchId }, 422],
      [{ ...user, role: "barber", branchId: other.branchId }, 404],
      [{ ...user, role: "barber", branchId }, 201],
      [{ ...user, role: "manager", branchId }, 409],
    ] as const) {
      expect(
        (await api("POST", "/v1/users", { ...asOwner, body })).status,
      ).toBe(status);
    }
  });

  test("nobody escalates privileges or locks themselves out", async () => {
    const { tenant, host, branchId, owner, asOwner } = await createShop();
    const admin = await createUser(tenant, "admin");
    const otherAdmin = await createUser(tenant, "admin");
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const asAdmin = { host, token: admin.token };
    const patch = (
      who: { host: string; token: string },
      id: ObjectId,
      body: unknown,
    ) => api("PATCH", `/v1/users/${id}`, { ...who, body });

    expect(
      (
        await api("POST", "/v1/users", {
          ...asAdmin,
          body: { name: "Nuevo", email: "x@example.com", role: "admin" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await patch(asAdmin, otherAdmin.user._id, { name: "Equis" })).status,
    ).toBe(403);
    expect(
      (await patch(asAdmin, owner.user._id, { name: "Equis" })).status,
    ).toBe(403);
    expect(
      (await patch(asOwner, owner.user._id, { name: "Equis" })).status,
    ).toBe(403);
    expect(
      (await patch(asAdmin, manager.user._id, { role: "admin" })).status,
    ).toBe(403);
    expect(
      (await patch(asAdmin, admin.user._id, { active: false })).status,
    ).toBe(403);
    expect(
      (await patch(asAdmin, admin.user._id, { name: "Admin Renombrado" }))
        .status,
    ).toBe(200);
    expect(
      (await patch(asOwner, otherAdmin.user._id, { role: "manager", branchId }))
        .status,
    ).toBe(200);
    expect(
      (await api("GET", "/v1/users", { host, token: manager.token })).status,
    ).toBe(403);
  });

  test("deactivation and role changes take effect immediately", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    const barber = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });

    expect(
      (await api("GET", "/v1/branches", { host, token: manager.token })).status,
    ).toBe(200);
    await api("PATCH", `/v1/users/${manager.user._id}`, {
      ...asOwner,
      body: { active: false },
    });
    expect(
      (await api("GET", "/v1/branches", { host, token: manager.token })).status,
    ).toBe(401);

    const rename = {
      host,
      token: barber.token,
      body: { name: "Centro Nuevo" },
    };
    expect(
      (await api("PATCH", `/v1/branches/${branchId}`, rename)).status,
    ).toBe(403);
    await api("PATCH", `/v1/users/${barber.user._id}`, {
      ...asOwner,
      body: { role: "manager" },
    });
    expect(
      (await api("PATCH", `/v1/branches/${branchId}`, rename)).status,
    ).toBe(200);
  });

  test("a new temporary password replaces the old one and signs the account out", async () => {
    const { tenant, host, branchId, asOwner, owner } = await createShop();
    const barber = await createUser(tenant, "barber", {
      branchId: new ObjectId(branchId),
    });
    const admin = await createUser(tenant, "admin");
    const other = await createUser(tenant, "admin");
    const customer = await createUser(tenant, "customer");
    const reset = (id: ObjectId, as = asOwner) =>
      api("POST", `/v1/users/${id}/password`, as);

    const res = await reset(barber.user._id);
    expect(res.status).toBe(200);
    const temporary = String(res.body.temporaryPassword);
    expect(temporary.length).toBeGreaterThanOrEqual(16);
    expect(
      (await api("GET", "/v1/auth/me", { host, token: barber.token })).status,
    ).toBe(401);
    const old = await api("POST", "/v1/auth/login", {
      host,
      body: { email: barber.user.email, password: PASSWORD },
    });
    expect(old.status).toBe(401);
    const login = await api("POST", "/v1/auth/login", {
      host,
      body: { email: barber.user.email, password: temporary },
    });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ mustChangePassword: true });

    const asAdmin = { host, token: admin.token };
    expect((await reset(other.user._id, asAdmin)).status).toBe(403);
    expect((await reset(admin.user._id, asAdmin)).status).toBe(403);
    expect((await reset(owner.user._id, asAdmin)).status).toBe(403);
    expect((await reset(owner.user._id)).status).toBe(403);
    expect((await reset(customer.user._id)).status).toBe(404);
    expect((await reset(other.user._id)).status).toBe(200);
    const elsewhere = await createShop();
    expect((await reset(barber.user._id, elsewhere.asOwner)).status).toBe(404);
  });

  test("a manager moved to another branch loses the old one", async () => {
    const { tenant, host, branchId, asOwner } = await createShop();
    const second = await addBranch(host, asOwner.token);
    const manager = await createUser(tenant, "manager", {
      branchId: new ObjectId(branchId),
    });
    await api("PATCH", `/v1/users/${manager.user._id}`, {
      ...asOwner,
      body: { branchId: second },
    });
    const asManager = { host, token: manager.token };
    expect(
      (await api("GET", `/v1/branches/${branchId}`, asManager)).status,
    ).toBe(404);
    expect((await api("GET", `/v1/branches/${second}`, asManager)).status).toBe(
      200,
    );
  });
});

describe("password change", () => {
  test("needs the current password, keeps this session and signs out the others", async () => {
    const { tenant, host } = await createTenant();
    const { user, token } = await createUser(tenant, "customer");
    const other = await api("POST", "/v1/auth/login", {
      host,
      body: { email: user.email, password: PASSWORD },
    });
    const change = (body: unknown) =>
      api("POST", "/v1/auth/password", { host, token, body });

    const wrong = await change({
      currentPassword: "not-it",
      newPassword: "nueva-clave-123",
    });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error?.code).toBe("WRONG_PASSWORD");
    expect(
      (await change({ currentPassword: PASSWORD, newPassword: "short" }))
        .status,
    ).toBe(422);
    expect(
      (
        await change({
          currentPassword: PASSWORD,
          newPassword: "nueva-clave-123",
        })
      ).status,
    ).toBe(204);

    expect((await api("GET", "/v1/auth/me", { host, token })).status).toBe(200);
    expect(
      (
        await api("GET", "/v1/auth/me", {
          host,
          token: String(other.body.token),
        })
      ).status,
    ).toBe(401);
    const login = (password: string) =>
      api("POST", "/v1/auth/login", {
        host,
        body: { email: user.email, password },
      });
    expect((await login("nueva-clave-123")).status).toBe(200);
    expect((await login(PASSWORD)).status).toBe(401);
  });
});
