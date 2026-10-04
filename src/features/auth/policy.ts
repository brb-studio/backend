import type { ObjectId } from "mongodb";
import type { Role } from "../../db/scoped";
import type { Auth } from "../../shared/http";

export const STAFF: Role[] = ["owner", "admin", "manager", "barber"];

export const isTenantWide = (auth: Auth) =>
  auth.role === "owner" || auth.role === "admin";

export const visibleBranchIds = (auth: Auth): ObjectId[] | null => {
  if (isTenantWide(auth)) return null;
  return auth.branchId ? [auth.branchId] : [];
};
