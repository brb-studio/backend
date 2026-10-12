import type { ObjectId } from "mongodb";
import { hit } from "../../db/rate-limit";
import {
  type AuthTokenDoc,
  forTenant,
  type Locale,
  platform,
  type TenantDoc,
  type UserDoc,
} from "../../db/scoped";
import { AppError } from "../../shared/http";
import { sendMail } from "../../shared/mail";
import { randomToken, sha256 } from "./service";

type Kind = AuthTokenDoc["kind"];
const TTL_MS: Record<Kind, number> = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 60 * 60 * 1000,
};
const HOUR_MS = 60 * 60 * 1000;
const tooMany = () =>
  new AppError(429, "RATE_LIMITED", "Too many attempts, try again later");
const invalidToken = () =>
  new AppError(400, "INVALID_TOKEN", "This link is invalid or has expired");

/** Where the emailed link lands: the barbershop's own site, in the language the person was using. */
export type Link = { origin: string; locale: Locale };

const copy = {
  es: {
    verify: (shop: string, url: string) => ({
      subject: `Confirma tu correo en ${shop}`,
      text: `Confirma tu correo para tu cuenta en ${shop}:\n\n${url}\n\nEl enlace vence en 24 horas. Si no creaste la cuenta, ignora este mensaje.`,
    }),
    reset: (shop: string, url: string) => ({
      subject: `Restablece tu contraseña de ${shop}`,
      text: `Usa este enlace para elegir una contraseña nueva en ${shop}:\n\n${url}\n\nVence en 1 hora y solo sirve una vez. Si no lo pediste, ignora este mensaje: tu contraseña no cambia.`,
    }),
  },
  en: {
    verify: (shop: string, url: string) => ({
      subject: `Confirm your email at ${shop}`,
      text: `Confirm your email for your ${shop} account:\n\n${url}\n\nThe link expires in 24 hours. If you didn't create the account, ignore this message.`,
    }),
    reset: (shop: string, url: string) => ({
      subject: `Reset your ${shop} password`,
      text: `Use this link to choose a new password at ${shop}:\n\n${url}\n\nIt expires in 1 hour and works once. If you didn't ask for it, ignore this message: your password stays the same.`,
    }),
  },
} satisfies Record<Locale, unknown>;

async function issue(tenantId: ObjectId, userId: ObjectId, kind: Kind) {
  const t = forTenant(tenantId);
  const now = new Date();
  // Only the newest link works: asking again retires the previous one.
  await t.authTokens.updateMany(
    { userId, kind, usedAt: { $exists: false } },
    { $set: { usedAt: now } },
  );
  const token = randomToken(32);
  await t.authTokens.insertOne({
    _id: sha256(token),
    userId,
    kind,
    expiresAt: new Date(now.getTime() + TTL_MS[kind]),
    createdAt: now,
  });
  return token;
}

/** Single use, atomic: two requests with the same link can't both pass. */
async function consume(tenantId: ObjectId, token: string, kind: Kind) {
  const now = new Date();
  const used = await forTenant(tenantId).authTokens.findOneAndUpdate(
    {
      _id: sha256(token),
      kind,
      usedAt: { $exists: false },
      expiresAt: { $gt: now },
    },
    { $set: { usedAt: now } },
  );
  if (!used) throw invalidToken();
  return used;
}

type Mailable = Pick<UserDoc, "_id" | "email">;

/** Emails the link that proves control of the address. Not awaited by callers' latency-sensitive paths. */
export async function sendVerification(
  tenant: Pick<TenantDoc, "_id" | "name">,
  user: Mailable,
  link: Link,
) {
  if (!user.email) return;
  const token = await issue(tenant._id, user._id, "verify_email");
  const url = `${link.origin}/${link.locale}/verify-email?token=${token}`;
  await sendMail({
    to: user.email,
    ...copy[link.locale].verify(tenant.name, url),
  });
}

export async function requestVerification(
  tenant: TenantDoc,
  userId: ObjectId,
  link: Link,
) {
  const user = await forTenant(tenant._id).users.findOne({ _id: userId });
  if (!user?.email || user.emailVerifiedAt) return;
  if (!(await hit(`verify:${tenant._id}:${userId}`, 3, HOUR_MS))) {
    throw tooMany();
  }
  await sendVerification(tenant, user, link);
}

export async function verifyEmail(tenantId: ObjectId, token: string) {
  const used = await consume(tenantId, token, "verify_email");
  await forTenant(tenantId).users.updateOne(
    { _id: used.userId, emailVerifiedAt: { $exists: false } },
    { $set: { emailVerifiedAt: new Date(), updatedAt: new Date() } },
  );
}

export async function forgotPassword(
  tenant: TenantDoc,
  email: string,
  ip: string,
  link: Link,
) {
  const [byIp, byEmail] = [
    await hit(`forgot-ip:${tenant._id}:${ip}`, 20, 15 * 60 * 1000),
    await hit(`forgot:${tenant._id}:${email}`, 20, HOUR_MS),
  ];
  if (!byIp || !byEmail) throw tooMany();
  const user = await forTenant(tenant._id).users.findOne({
    email,
    active: true,
    passwordHash: { $exists: true },
  });
  if (!user) return;
  const token = await issue(tenant._id, user._id, "reset_password");
  const url = `${link.origin}/${link.locale}/reset-password?token=${token}`;
  // Not awaited: the answer must not take longer when the account exists.
  void sendMail({ to: email, ...copy[link.locale].reset(tenant.name, url) });
}

export async function resetPassword(
  tenantId: ObjectId,
  token: string,
  newPassword: string,
  ip: string,
) {
  if (!(await hit(`reset-ip:${tenantId}:${ip}`, 20, 15 * 60 * 1000))) {
    throw tooMany();
  }
  const used = await consume(tenantId, token, "reset_password");
  const now = new Date();
  const user = await forTenant(tenantId).users.findOneAndUpdate(
    { _id: used.userId, active: true },
    {
      // Following the link proves the inbox is theirs, so the email counts as verified.
      $set: {
        passwordHash: await Bun.password.hash(newPassword),
        updatedAt: now,
      },
    },
  );
  if (!user) throw invalidToken();
  if (!user.emailVerifiedAt) {
    await forTenant(tenantId).users.updateOne(
      { _id: user._id },
      { $set: { emailVerifiedAt: now } },
    );
  }
  // Whoever had the old password (or a stolen session) is signed out everywhere.
  await platform.sessions.deleteMany({ userId: user._id });
}
