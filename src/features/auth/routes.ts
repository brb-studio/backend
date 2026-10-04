import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Role } from "../../db/scoped";
import { AppError, type Env, parseId, readJson } from "../../shared/http";
import { requireActiveSubscription } from "../tenancy/subscription";
import { STAFF } from "./policy";
import {
  loginSchema,
  passwordSchema,
  registerSchema,
  staffCreate,
  staffUpdate,
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

export function authOf(c: Context<Env>, roles: Role[] = ANYONE) {
  const auth = c.var.auth;
  if (!auth) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  if (!roles.includes(auth.role)) {
    throw new AppError(403, "FORBIDDEN", "Not allowed");
  }
  return auth;
}

const session = (r: {
  token: string;
  expiresAt: Date;
  user: Parameters<typeof toUser>[0];
}) => ({ token: r.token, expiresAt: r.expiresAt, user: toUser(r.user) });

export const authRoutes = new Hono<Env>()
  .post("/register", async (c) => {
    const input = await readJson(c, registerSchema);
    return c.json(session(await register(c.var.tenant._id, input)), 201);
  })
  .post("/login", async (c) => {
    const { email, password } = await readJson(c, loginSchema);
    return c.json(session(await login(c.var.tenant._id, email, password)));
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
  .get("/me", async (c) => c.json({ user: toUser(await getUser(authOf(c))) }));

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
