import type { Collection, ObjectId } from "mongodb";
import type { TenantDoc } from "../../src/db/collections";
import { SLUG, TENANT_ID } from "./ids";

/** Everything the seed must check before it writes a single document. Fails closed: any doubt throws. */
export type Target = {
  nodeEnv: string;
  /** `VERCEL` / `VERCEL_ENV`: set on every Vercel deployment. */
  vercel?: string;
  stripeKey?: string;
  mongoUrl: string;
  dbName: string;
  /** One more database the caller vouches for (seed:qa writes the local dev database). */
  allowDb?: string;
};

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/;
const ALLOWED_DB = /^(brb-showcase|brb-showcase_e2e|[A-Za-z0-9_-]+_test)$/;

export const mongoHosts = (url: string) =>
  url
    .replace(/^mongodb(\+srv)?:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .split(/[/?]/)[0]
    ?.split(",")
    .filter(Boolean) ?? [];

export class GuardError extends Error {
  override name = "GuardError";
}

/** Pure: environment, server and database name. */
export function assertSafeTarget(target: Target) {
  if (target.nodeEnv === "production") {
    throw new GuardError(
      "seed:showcase refuses to run with NODE_ENV=production",
    );
  }
  if (target.vercel) {
    throw new GuardError("seed:showcase refuses to run on Vercel");
  }
  if (target.stripeKey?.includes("_live_")) {
    throw new GuardError("seed:showcase refuses to run with a live Stripe key");
  }
  if (target.mongoUrl.startsWith("mongodb+srv://")) {
    throw new GuardError(
      "seed:showcase only writes to a local MongoDB (no +srv)",
    );
  }
  const hosts = mongoHosts(target.mongoUrl);
  if (hosts.length === 0 || !hosts.every((host) => LOCAL_HOST.test(host))) {
    throw new GuardError(
      `seed:showcase only writes to a local MongoDB, not ${hosts.join(",") || "?"}`,
    );
  }
  if (!ALLOWED_DB.test(target.dbName) && target.dbName !== target.allowDb) {
    throw new GuardError(
      `seed:showcase only writes to brb-showcase, brb-showcase_e2e or a *_test database, not "${target.dbName}"`,
    );
  }
}

/** Pure: what the database already holds. */
export function assertFreeDatabase(state: {
  dbName: string;
  slugOwner?: ObjectId;
  otherTenants: string[];
  shared: boolean;
}) {
  if (state.slugOwner && !state.slugOwner.equals(TENANT_ID)) {
    throw new GuardError(
      `"${SLUG}" already belongs to another tenant in "${state.dbName}"; nothing was written`,
    );
  }
  if (state.otherTenants.length > 0 && !state.shared) {
    throw new GuardError(
      `"${state.dbName}" holds other tenants (${state.otherTenants.join(", ")}); use a dedicated database or pass --shared`,
    );
  }
}

export async function checkDatabase(
  tenants: Collection<TenantDoc>,
  dbName: string,
  shared: boolean,
) {
  const owner = await tenants.findOne(
    { slug: SLUG },
    { projection: { _id: 1 } },
  );
  const others = await tenants
    .find({ _id: { $ne: TENANT_ID } }, { projection: { slug: 1 } })
    .limit(5)
    .toArray();
  assertFreeDatabase({
    dbName,
    ...(owner && { slugOwner: owner._id }),
    otherTenants: others.map((t) => t.slug),
    shared,
  });
}
