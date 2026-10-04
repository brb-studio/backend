import { ObjectId } from "mongodb";
import { hit } from "../../db/rate-limit";
import { forTenant, platform, type UserDoc } from "../../db/scoped";
import { AppError, type Auth, isDuplicate } from "../../shared/http";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const sha256 = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

export const randomToken = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );

export async function createSession(
  user: Pick<UserDoc, "_id" | "tenantId">,
  now = new Date(),
) {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await platform.sessions.insertOne({
    _id: sha256(token),
    tenantId: user.tenantId,
    userId: user._id,
    expiresAt,
    createdAt: now,
  });
  return { token, expiresAt };
}

export async function sessionAuth(
  token: string,
  tenantId: ObjectId,
  now = new Date(),
): Promise<Auth | null> {
  const _id = sha256(token);
  const session = await platform.sessions.findOne({ _id });
  if (
    !session ||
    session.expiresAt <= now ||
    !session.tenantId.equals(tenantId)
  ) {
    return null;
  }
  const user = await forTenant(tenantId).users.findOne({
    _id: session.userId,
    active: true,
  });
  if (!user) return null;
  if (session.expiresAt.getTime() - now.getTime() < SESSION_TTL_MS / 2) {
    await platform.sessions.updateOne(
      { _id },
      { $set: { expiresAt: new Date(now.getTime() + SESSION_TTL_MS) } },
    );
  }
  return {
    userId: user._id,
    tenantId,
    role: user.role,
    ...(user.branchId && { branchId: user.branchId }),
  };
}

export async function logout(token: string) {
  await platform.sessions.deleteOne({ _id: sha256(token) });
}

export async function register(
  tenantId: ObjectId,
  input: { name: string; email: string; phone?: string; password: string },
) {
  const now = new Date();
  const user: UserDoc = {
    _id: new ObjectId(),
    tenantId,
    email: input.email,
    name: input.name,
    phone: input.phone,
    role: "customer",
    active: true,
    passwordHash: await Bun.password.hash(input.password),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await forTenant(tenantId).users.insertOne(user);
  } catch (err) {
    if (isDuplicate(err)) {
      throw new AppError(409, "EMAIL_TAKEN", "Email already registered");
    }
    throw err;
  }
  return { user, ...(await createSession(user, now)) };
}

let timingHash: Promise<string> | undefined;

export async function login(
  tenantId: ObjectId,
  email: string,
  password: string,
) {
  if (
    !(await hit(`login:${tenantId}:${email}`, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS))
  ) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many attempts, try again later",
    );
  }
  const user = await forTenant(tenantId).users.findOne({ email });
  timingHash ??= Bun.password.hash("timing-only, not a real password");
  const valid = await Bun.password.verify(
    password,
    user?.passwordHash ?? (await timingHash),
  );
  if (!user || !valid || !user.active) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }
  return { user, ...(await createSession(user)) };
}

export async function changePassword(
  auth: Auth,
  token: string,
  current: string,
  next: string,
) {
  if (
    !(await hit(`password:${auth.userId}`, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS))
  ) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many attempts, try again later",
    );
  }
  const user = await getUser(auth);
  if (!(await Bun.password.verify(current, user.passwordHash))) {
    throw new AppError(403, "WRONG_PASSWORD", "Current password is wrong");
  }
  await forTenant(auth.tenantId).users.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordHash: await Bun.password.hash(next),
        updatedAt: new Date(),
      },
    },
  );
  await platform.sessions.deleteMany({
    userId: user._id,
    _id: { $ne: sha256(token) },
  });
}

export async function getUser(auth: Auth) {
  const user = await forTenant(auth.tenantId).users.findOne({
    _id: auth.userId,
  });
  if (!user) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  return user;
}

export const toUser = (user: UserDoc) => ({
  id: user._id.toHexString(),
  name: user.name,
  email: user.email,
  ...(user.phone && { phone: user.phone }),
  role: user.role,
  active: user.active,
  ...(user.branchId && { branchId: user.branchId.toHexString() }),
});
