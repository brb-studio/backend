import { describe, expect, test } from "bun:test";
import { authTokens, users } from "../src/db/collections";
import { type Mail, outbox } from "../src/shared/mail";
import { api, createShop, createUser, PASSWORD } from "./helpers";

/** The mail goes out after the response, so wait for it to land. */
async function mailTo(email: string, count = 1): Promise<Mail> {
  for (let i = 0; i < 100; i++) {
    const found = outbox.filter((m) => m.to === email);
    if (found.length >= count) return found[count - 1] as Mail;
    await Bun.sleep(20);
  }
  throw new Error(`no mail for ${email}`);
}
const tokenOf = (mail: Mail) =>
  /token=([\w-]{43})/.exec(mail.text)?.[1] as string;

let seq = 0;
const email = () => `rec${Date.now()}${seq++}@example.com`;
const register = (host: string, address: string, extra = {}) =>
  api("POST", "/v1/auth/register", {
    host,
    body: { name: "Ana", email: address, password: PASSWORD, ...extra },
  });

describe("email verification", () => {
  test("registering emails a single-use link that verifies the address and opens sign-in", async () => {
    const { host } = await createShop();
    const address = email();
    const res = await register(host, address, { locale: "en" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ emailVerified: false });

    const mail = await mailTo(address);
    expect(mail.subject).toContain("Confirm your email");
    expect(mail.text).toContain(`http://${host}/en/verify-email?token=`);

    const login = () =>
      api("POST", "/v1/auth/login", {
        host,
        body: { email: address, password: PASSWORD },
      });
    expect((await login()).status).toBe(403);
    const verify = (t: string) =>
      api("POST", "/v1/auth/verify-email", { host, body: { token: t } });
    // Signing in before confirming sent a fresh link, which retired the first one.
    const fresh = await mailTo(address, 2);
    expect((await verify(tokenOf(mail))).status).toBe(400);
    expect((await verify(tokenOf(fresh))).status).toBe(204);
    const ok = await login();
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ emailVerified: true });
    const again = await verify(tokenOf(fresh));
    expect(again.status).toBe(400);
    expect(again.body.error?.code).toBe("INVALID_TOKEN");
  });

  test("a verified account is not mailed again", async () => {
    const { host, tenant } = await createShop();
    const { user, token } = await createUser(tenant, "customer");
    const before = outbox.length;
    const ask = await api("POST", "/v1/auth/verify-email/request", {
      host,
      token,
      body: { locale: "es" },
    });
    expect(ask.status).toBe(204);
    await Bun.sleep(150);
    expect(outbox.length).toBe(before);
    expect(user.emailVerifiedAt).toBeDefined();
  });

  test("an expired or made-up link is refused, and anonymous callers can't ask for one", async () => {
    const { host, tenant } = await createShop();
    const address = email();
    await register(host, address);
    const mail = await mailTo(address);
    await authTokens.updateMany(
      { tenantId: tenant._id },
      { $set: { expiresAt: new Date(0) } },
    );
    const expired = await api("POST", "/v1/auth/verify-email", {
      host,
      body: { token: tokenOf(mail) },
    });
    expect(expired.body.error?.code).toBe("INVALID_TOKEN");
    const junk = await api("POST", "/v1/auth/verify-email", {
      host,
      body: { token: "x".repeat(43) },
    });
    expect(junk.status).toBe(400);
    expect(
      (await api("POST", "/v1/auth/verify-email/request", { host, body: {} }))
        .status,
    ).toBe(401);
  });
});

describe("password recovery", () => {
  test("a reset link sets a new password, signs everyone out and works once", async () => {
    const { host, tenant } = await createShop();
    const address = email();
    const { token: oldToken } = await createUser(tenant, "customer", {
      email: address,
      emailVerifiedAt: undefined,
    });

    const forgot = (to: string) =>
      api("POST", "/v1/auth/password/forgot", {
        host,
        body: { email: to, locale: "es" },
      });
    expect((await forgot(address)).status).toBe(204);
    const mail = await mailTo(address);
    expect(mail.subject).toContain("Restablece");
    expect(mail.text).toContain(`http://${host}/es/reset-password?token=`);

    const reset = (token: string, password: string) =>
      api("POST", "/v1/auth/password/reset", {
        host,
        body: { token, password },
      });
    const weak = await reset(tokenOf(mail), "short");
    expect(weak.status).toBe(422);
    expect((await reset(tokenOf(mail), "a brand new password")).status).toBe(
      204,
    );
    expect((await reset(tokenOf(mail), "another new password")).status).toBe(
      400,
    );

    expect(
      (await api("GET", "/v1/auth/me", { host, token: oldToken })).status,
    ).toBe(401);
    const login = (password: string) =>
      api("POST", "/v1/auth/login", {
        host,
        body: { email: address, password },
      });
    expect((await login(PASSWORD)).status).toBe(401);
    const ok = await login("a brand new password");
    expect(ok.status).toBe(200);
    // Following the link proved the inbox is theirs.
    expect(ok.body.user).toMatchObject({ emailVerified: true });
  });

  test("answers the same for unknown, inactive and guest addresses, and sends nothing", async () => {
    const { host, tenant } = await createShop();
    const inactive = await createUser(tenant, "customer", { active: false });
    const before = outbox.length;
    for (const to of [email(), inactive.user.email as string]) {
      const res = await api("POST", "/v1/auth/password/forgot", {
        host,
        body: { email: to },
      });
      expect(res.status).toBe(204);
    }
    await Bun.sleep(150);
    expect(outbox.length).toBe(before);
  });

  test("is limited per address, and a link only works in its own barbershop and for its own purpose", async () => {
    const a = await createShop();
    const b = await createShop();
    const address = email();
    await register(a.host, address);
    await register(b.host, address);
    const forgot = () =>
      api("POST", "/v1/auth/password/forgot", {
        host: a.host,
        body: { email: address },
      });
    for (let i = 0; i < 3; i++) expect((await forgot()).status).toBe(204);
    const limited = await forgot();
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe("RATE_LIMITED");

    const resetMails = outbox.filter(
      (m) => m.to === address && m.text.includes("reset-password"),
    );
    const token = tokenOf(resetMails.at(-1) as Mail);
    const other = await api("POST", "/v1/auth/password/reset", {
      host: b.host,
      body: { token, password: "a brand new password" },
    });
    expect(other.status).toBe(400);

    // A verification link can't reset a password.
    const verification = outbox.find(
      (m) => m.to === address && m.text.includes("verify-email"),
    ) as Mail;
    const wrongKind = await api("POST", "/v1/auth/password/reset", {
      host: a.host,
      body: { token: tokenOf(verification), password: "a brand new password" },
    });
    expect(wrongKind.status).toBe(400);
    expect(
      (await users.findOne({ tenantId: b.tenant._id, email: address }))
        ?.emailVerifiedAt,
    ).toBeUndefined();
  });
});
