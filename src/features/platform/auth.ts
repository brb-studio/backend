import { createMiddleware } from "hono/factory";
import type { ObjectId, WithId } from "mongodb";
import { hit } from "../../db/rate-limit";
import { type PlatformStaffDoc, platform } from "../../db/scoped";
import { AppError, type Env } from "../../shared/http";
import { randomToken } from "../auth/service";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

let timingHash: Promise<string> | undefined;

export async function platformLogin(email: string, password: string) {
  if (
    !(await hit(`platform-login:${email}`, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS))
  ) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many attempts, try again later",
    );
  }
  const staff = await platform.staff.findOne({ email });
  timingHash ??= Bun.password.hash("timing-only, not a real password");
  const valid = await Bun.password.verify(
    password,
    staff?.passwordHash ?? (await timingHash),
  );
  if (!staff || !valid || !staff.active) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }
  const token = randomToken(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await platform.staffSessions.insertOne({
    _id: sha256(token),
    staffId: staff._id,
    expiresAt,
    createdAt: now,
  });
  return { token, expiresAt, staff };
}

export const platformLogout = (token: string) =>
  platform.staffSessions.deleteOne({ _id: sha256(token) });

async function staffOf(token: string, now = new Date()) {
  const session = await platform.staffSessions.findOne({ _id: sha256(token) });
  if (!session || session.expiresAt <= now) return null;
  return platform.staff.findOne({ _id: session.staffId, active: true });
}

export const toStaff = (
  staff: WithId<Pick<PlatformStaffDoc, "name" | "email">>,
) => ({
  id: staff._id.toHexString(),
  name: staff.name,
  email: staff.email,
});

export const bearerOf = (header: string | undefined) =>
  /^Bearer ([\w-]{43})$/.exec(header ?? "")?.[1];

export const requirePlatformStaff = createMiddleware<Env>(async (c, next) => {
  const token = bearerOf(c.req.header("Authorization"));
  const staff = token ? await staffOf(token) : null;
  if (!staff) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  c.set("platformStaffId", staff._id satisfies ObjectId);
  await next();
});

export const getStaff = async (id: ObjectId) => {
  const staff = await platform.staff.findOne({ _id: id });
  if (!staff) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  return staff;
};
