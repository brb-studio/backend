import { createHash } from "node:crypto";
import { rateLimits } from "./collections";

/**
 * Fixed-window counter shared by every API instance: one atomic upsert per attempt, so two servers can't
 * both let the 21st request through. MongoDB's TTL index deletes old windows; until it runs, an expired
 * window simply restarts at 1. Keys are hashed, so no email or phone is stored.
 */
export async function hit(
  key: string,
  limit: number,
  windowMs: number,
  now = new Date(),
) {
  const open = { $gt: ["$expiresAt", now] };
  const window = await rateLimits.findOneAndUpdate(
    { _id: createHash("sha256").update(key).digest("base64url") },
    [
      {
        $set: {
          count: { $cond: [open, { $add: ["$count", 1] }, 1] },
          expiresAt: {
            $cond: [open, "$expiresAt", new Date(now.getTime() + windowMs)],
          },
        },
      },
    ],
    { upsert: true, returnDocument: "after" },
  );
  return (window?.count ?? 1) <= limit;
}
