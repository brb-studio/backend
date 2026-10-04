import { ObjectId } from "mongodb";
import type * as z from "zod";
import { forTenant, platform, type UserDoc } from "../../db/scoped";
import { AppError, type Auth, isDuplicate } from "../../shared/http";
import { getBranch } from "../tenancy/service";
import type { STAFF_ROLES, staffCreate, staffUpdate } from "./schemas";
import { randomToken } from "./service";

const forbidden = () => new AppError(403, "FORBIDDEN", "Not allowed");
const needsBranch = () =>
  new AppError(422, "VALIDATION", "Invalid request", [
    {
      path: "branchId",
      message: "required for managers and barbers, not allowed for admins",
    },
  ]);

function assertCanGrant(auth: Auth, role: (typeof STAFF_ROLES)[number]) {
  if (role === "admin" && auth.role !== "owner") throw forbidden();
}

export const listStaff = (auth: Auth) =>
  forTenant(auth.tenantId)
    .users.find({ role: { $ne: "customer" } })
    .sort({ name: 1 })
    .toArray();

export async function createStaff(
  auth: Auth,
  input: z.output<typeof staffCreate>,
) {
  assertCanGrant(auth, input.role);
  if (input.branchId) await getBranch(auth, input.branchId);
  const temporaryPassword = randomToken(12);
  const now = new Date();
  const user: UserDoc = {
    _id: new ObjectId(),
    tenantId: auth.tenantId,
    email: input.email,
    name: input.name,
    role: input.role,
    branchId: input.branchId,
    active: true,
    passwordHash: await Bun.password.hash(temporaryPassword),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await forTenant(auth.tenantId).users.insertOne(user);
  } catch (err) {
    if (isDuplicate(err)) {
      throw new AppError(409, "EMAIL_TAKEN", "Email already registered");
    }
    throw err;
  }
  return { user, temporaryPassword };
}

export async function updateStaff(
  auth: Auth,
  id: ObjectId,
  input: z.output<typeof staffUpdate>,
) {
  const t = forTenant(auth.tenantId);
  const target = await t.users.findOne({ _id: id, role: { $ne: "customer" } });
  if (!target) throw new AppError(404, "NOT_FOUND", "Not found");
  const self = target._id.equals(auth.userId);
  if (target.role === "owner") throw forbidden();
  if (target.role === "admin" && auth.role !== "owner" && !self) {
    throw forbidden();
  }
  const changesAccess =
    input.role !== undefined ||
    input.branchId !== undefined ||
    input.active !== undefined;
  if (changesAccess && self) throw forbidden();
  if (input.role) assertCanGrant(auth, input.role);

  const role = input.role ?? target.role;
  if (role === "admin" && input.branchId) throw needsBranch();
  const branchId =
    role === "admin" ? undefined : (input.branchId ?? target.branchId);
  if (role !== "admin" && !branchId) throw needsBranch();
  if (input.branchId) await getBranch(auth, input.branchId);

  const moves =
    role !== target.role || String(branchId) !== String(target.branchId);
  if (moves && (await t.barbers.findOne({ userId: id }))) {
    throw new AppError(
      409,
      "LINKED_BARBER",
      "Unlink this account from its barber profile first",
    );
  }

  const updated = await t.users.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        role,
        ...(branchId && { branchId }),
        ...(input.name && { name: input.name }),
        ...(input.active !== undefined && { active: input.active }),
        updatedAt: new Date(),
      },
      ...(!branchId && { $unset: { branchId: "" } }),
    },
    { returnDocument: "after" },
  );
  if (!updated) throw new AppError(404, "NOT_FOUND", "Not found");
  if (input.active === false)
    await platform.sessions.deleteMany({ userId: id });
  return updated;
}
