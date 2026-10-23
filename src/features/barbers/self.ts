import type { ObjectId } from "mongodb";
import { forTenant, type TenantDoc } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth } from "../../shared/http";
import { getUser } from "../auth/service";
import { createBarber } from "./service";

const MAX_SLUG_TRIES = 5;

export const slugOf = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "barbero";

export async function becomeBarber(
  tenant: TenantDoc,
  auth: Auth,
  branchId?: ObjectId,
) {
  const t = forTenant(tenant._id);
  if (await t.barbers.findOne({ userId: auth.userId })) {
    throw new AppError(
      409,
      "USER_LINKED",
      "That account already has a barber profile",
    );
  }
  const branches = branchId
    ? [branchId]
    : await collect(
        t.branches
          .find({ active: true })
          .project<{ _id: ObjectId }>({ _id: 1 })
          .limit(2),
        (b) => b._id,
      );
  const [branch] = branches;
  if (!branch || branches.length > 1) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "branchId", message: "choose the branch you work at" },
    ]);
  }
  const user = await getUser(auth);
  const serviceIds = await collect(
    t.services
      .find({
        active: true,
        $or: [{ branchId: { $exists: false } }, { branchId: branch }],
      })
      .project<{ _id: ObjectId }>({ _id: 1 }),
    (s) => s._id,
  );
  const base = slugOf(user.name);
  for (let attempt = 1; ; attempt++) {
    try {
      return await createBarber(tenant, auth, {
        branchId: branch,
        name: user.name,
        slug: attempt === 1 ? base : `${base}-${attempt}`,
        serviceIds,
        userId: auth.userId,
      });
    } catch (err) {
      const taken = err instanceof AppError && err.code === "SLUG_TAKEN";
      if (!taken || attempt >= MAX_SLUG_TRIES) throw err;
    }
  }
}
