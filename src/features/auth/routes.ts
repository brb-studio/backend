import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { config } from "../../config";
import type { Role } from "../../db/scoped";
import {
  AppError,
  clientIp,
  type Env,
  parseId,
  readJson,
  tenantOrigin,
} from "../../shared/http";
import { requireActiveSubscription } from "../tenancy/subscription";
import { deleteAccount } from "./erase";
import { exportMyData } from "./export";
import { STAFF } from "./policy";
import { updateProfile } from "./profile";
import {
  forgotPassword,
  type Link,
  requestVerification,
  resetPassword,
  sendVerification,
  verifyEmail,
} from "./recovery";
import {
  eraseSchema,
  forgotSchema,
  localeSchema,
  loginSchema,
  passwordSchema,
  profileSchema,
  registerSchema,
  resetSchema,
  staffCreate,
  staffUpdate,
  tokenSchema,
} from "./schemas";
import {
  changePassword,
  getUser,
  login,
  logout,
  register,
  sessionAuth,
  toUser,
} from "./service";
import { createStaff, listStaff, updateStaff } from "./users";

const ANYONE: Role[] = [...STAFF, "customer"];

const bearer = (c: Context) =>
  /^Bearer ([\w-]{43})$/.exec(c.req.header("Authorization") ?? "")?.[1];

export const authenticate = createMiddleware<Env>(async (c, next) => {
  const token = bearer(c);
  const auth = token && (await sessionAuth(token, c.var.tenant._id));
  if (auth) c.set("auth", auth);
  await next();
});

export const requireRole = (...roles: Role[]) =>
  createMiddleware<Env>(async (c, next) => {
    authOf(c, roles);
    await next();
  });

/** What a account with a temporary password may still call: change the password, read who it is, sign out. */
const WHILE_PASSWORD_PENDING = new Set([
  "/v1/auth/password",
  "/v1/auth/me",
  "/v1/auth/logout",
]);

export function authOf(c: Context<Env>, roles: Role[] = ANYONE) {
  const auth = c.var.auth;
  if (!auth) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  if (!roles.includes(auth.role)) {
    throw new AppError(403, "FORBIDDEN", "Not allowed");
  }
  if (auth.mustChangePassword && !WHILE_PASSWORD_PENDING.has(c.req.path)) {
    throw new AppError(
      403,
      "PASSWORD_CHANGE_REQUIRED",
      "Choose your own password first",
    );
  }
  return auth;
}

const linkOf = (c: Context<Env>, locale?: Link["locale"]): Link => ({
  origin: tenantOrigin(c),
  locale: locale ?? c.var.tenant.defaultLocale,
});

const logMailError = (err: unknown) =>
  console.error(
    JSON.stringify({
      level: "error",
      event: "verification_mail_failed",
      message: err instanceof Error ? err.message : String(err),
    }),
  );

const session = (r: {
  token: string;
  expiresAt: Date;
  user: Parameters<typeof toUser>[0];
}) => ({ token: r.token, expiresAt: r.expiresAt, user: toUser(r.user) });

export const authRoutes = new Hono<Env>()
  .post("/register", async (c) => {
    const {
      locale,
      acceptTerms: _,
      ...input
    } = await readJson(c, registerSchema);
    const result = await register(c.var.tenant._id, input);
    // There is no session until the emailed link is followed, so a made-up address gets nowhere.
    sendVerification(c.var.tenant, result.user, linkOf(c, locale)).catch(
      logMailError,
    );
    return c.json({ user: toUser(result.user) }, 201);
  })
  .post("/login", async (c) => {
    const { email, password } = await readJson(c, loginSchema);
    const link = linkOf(c);
    const result = await login(c.var.tenant._id, email, password, (user) =>
      requestVerification(c.var.tenant, user._id, link).catch(logMailError),
    );
    return c.json(session(result));
  })
  .post("/logout", requireRole(...ANYONE), async (c) => {
    await logout(bearer(c) ?? "");
    return c.body(null, 204);
  })
  .post("/password", requireRole(...ANYONE), async (c) => {
    const { currentPassword, newPassword } = await readJson(c, passwordSchema);
    await changePassword(
      authOf(c),
      bearer(c) ?? "",
      currentPassword,
      newPassword,
    );
    return c.body(null, 204);
  })
  .post("/delete-account", requireRole("customer"), async (c) => {
    const { password } = await readJson(c, eraseSchema);
    await deleteAccount(authOf(c), password, c.var.tenant.defaultLocale);
    return c.body(null, 204);
  })
  .post("/verify-email/request", requireRole(...ANYONE), async (c) => {
    const { locale } = await readJson(c, localeSchema);
    await requestVerification(
      c.var.tenant,
      authOf(c).userId,
      linkOf(c, locale),
    );
    return c.body(null, 204);
  })
  .post("/verify-email", async (c) => {
    const { token } = await readJson(c, tokenSchema);
    await verifyEmail(c.var.tenant._id, token);
    return c.body(null, 204);
  })
  .post("/password/forgot", async (c) => {
    const { email, locale } = await readJson(c, forgotSchema);
    await forgotPassword(
      c.var.tenant,
      email,
      clientIp(c, config.PROXY_SECRET),
      linkOf(c, locale),
    );
    return c.body(null, 204);
  })
  .post("/password/reset", async (c) => {
    const { token, password } = await readJson(c, resetSchema);
    await resetPassword(
      c.var.tenant._id,
      token,
      password,
      clientIp(c, config.PROXY_SECRET),
    );
    return c.body(null, 204);
  })
  .get("/me", async (c) => c.json({ user: toUser(await getUser(authOf(c))) }))
  .get("/me/export", requireRole("customer"), async (c) =>
    c.json(await exportMyData(authOf(c), c.var.tenant.name)),
  )
  .patch("/me", requireRole("customer"), async (c) => {
    const input = await readJson(c, profileSchema);
    return c.json({ user: toUser(await updateProfile(authOf(c), input)) });
  });

export const userRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin"))
  .get("/", async (c) => c.json((await listStaff(authOf(c))).map(toUser)))
  .post("/", requireActiveSubscription, async (c) => {
    const input = await readJson(c, staffCreate);
    const { user, temporaryPassword } = await createStaff(authOf(c), input);
    return c.json({ user: toUser(user), temporaryPassword }, 201);
  })
  .patch("/:id", requireActiveSubscription, async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await readJson(c, staffUpdate);
    return c.json(toUser(await updateStaff(authOf(c), id, input)));
  });
