import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { users } from "../src/db/collections";
import { api, createShop, createUser, PASSWORD } from "./helpers";

describe("staff with a temporary password choose their own first", () => {
  test("until they change it, only the password, me and logout routes answer", async () => {
    const { tenant, host, branchId } = await createShop();
    const barber = await createUser(tenant, "barber", {
      email: "temp-barber@example.com",
      branchId: new ObjectId(branchId),
      mustChangePassword: true,
    });

    const login = await api("POST", "/v1/auth/login", {
      host,
      body: { email: "temp-barber@example.com", password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ user: { mustChangePassword: true } });
    const me = { host, token: String(login.body.token) };

    const locked = await api("GET", "/v1/appointments/my-day", me);
    expect(locked.status).toBe(403);
    expect(locked.body).toMatchObject({
      error: { code: "PASSWORD_CHANGE_REQUIRED" },
    });

    expect((await api("GET", "/v1/auth/me", me)).status).toBe(200);

    const changed = await api("POST", "/v1/auth/password", {
      ...me,
      body: { currentPassword: PASSWORD, newPassword: "mi propia clave 2026" },
    });
    expect(changed.status).toBe(204);
    expect(
      (await users.findOne({ _id: barber.user._id }))?.mustChangePassword,
    ).toBeUndefined();

    expect((await api("GET", "/v1/appointments/my-day", me)).status).toBe(200);
    const again = await api("POST", "/v1/auth/login", {
      host,
      body: {
        email: "temp-barber@example.com",
        password: "mi propia clave 2026",
      },
    });
    expect(again.body.user).not.toHaveProperty("mustChangePassword");
  });

  test("an account without the flag is never locked", async () => {
    const { tenant, host, branchId } = await createShop();
    await createUser(tenant, "barber", {
      email: "normal-barber@example.com",
      branchId: new ObjectId(branchId),
    });
    const login = await api("POST", "/v1/auth/login", {
      host,
      body: { email: "normal-barber@example.com", password: PASSWORD },
    });
    const res = await api("GET", "/v1/appointments/my-day", {
      host,
      token: String(login.body.token),
    });
    expect(res.status).toBe(200);
  });
});
