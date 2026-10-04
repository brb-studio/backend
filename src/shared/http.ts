import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  MongoNetworkError,
  MongoServerError,
  MongoServerSelectionError,
  ObjectId,
} from "mongodb";
import * as z from "zod";
import type { Role, TenantDoc } from "../db/collections";

export type Auth = {
  userId: ObjectId;
  tenantId: ObjectId;
  role: Role;
  branchId?: ObjectId;
};

export type Env = {
  Variables: RequestIdVariables & {
    tenant: TenantDoc;
    auth?: Auth;
  };
};

type Issue = { path: string; message: string };

export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string = code,
    readonly issues?: Issue[],
  ) {
    super(message);
  }
}

export function parse<T extends z.ZodType>(
  schema: T,
  data: unknown,
): z.output<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new AppError(
    422,
    "VALIDATION",
    "Invalid request",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

/** JSON bodies are small; only image uploads need the server's larger body limit. */
const JSON_LIMIT = 64 * 1024;

export async function readJson<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.output<T>> {
  const text = await c.req.text();
  if (text.length > JSON_LIMIT) {
    throw new AppError(413, "TOO_LARGE", "Body is too large");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError(400, "BAD_JSON", "Body must be valid JSON");
  }
  return parse(schema, data);
}

export function parseId(value: string | undefined) {
  if (!value || !/^[a-f\d]{24}$/.test(value)) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  return new ObjectId(value);
}

export const objectId = z
  .string()
  .regex(/^[a-f\d]{24}$/, "must be an id")
  .transform((id) => new ObjectId(id));

type ConnInfo = {
  requestIP?: (request: Request) => { address: string } | null;
};

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * The visitor's IP, for rate limits. Only the frontend's server can vouch for it: it sends the IP it
 * resolved in X-Forwarded-For together with the shared PROXY_SECRET. Anyone else gets their socket
 * address, so a forged header buys nothing.
 */
export function clientIp(c: Context, secret: string | undefined) {
  const sent = c.req.header("X-Proxy-Secret");
  const forwarded = c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim();
  if (
    secret &&
    sent &&
    forwarded &&
    timingSafeEqual(digest(sent), digest(secret))
  ) {
    return forwarded;
  }
  const server: ConnInfo | undefined = c.env;
  return server?.requestIP?.(c.req.raw)?.address ?? "unknown";
}

export const isDuplicate = (err: unknown) =>
  err instanceof MongoServerError && err.code === 11000;

export const duplicateKeys = (err: unknown): string[] =>
  isDuplicate(err)
    ? Object.keys((err as MongoServerError).keyPattern ?? {})
    : [];

export const notFound = (c: Context<Env>) =>
  c.json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);

export function onError(err: Error, c: Context<Env>) {
  const { status, code, message, issues } =
    toAppError(err) ?? new AppError(500, "INTERNAL", "Internal error");
  if (status >= 500) {
    console.error(
      JSON.stringify({
        level: "error",
        requestId: c.get("requestId"),
        name: err.name,
        message: err.message,
        stack: err.stack,
      }),
    );
  }
  return c.json(
    { error: { code, message, ...(issues && { issues }) } },
    status,
  );
}

function toAppError(err: Error) {
  if (err instanceof AppError) return err;
  if (isDuplicate(err)) return new AppError(409, "CONFLICT", "Already exists");
  if (
    err instanceof MongoNetworkError ||
    err instanceof MongoServerSelectionError
  ) {
    return new AppError(503, "UNAVAILABLE", "Service unavailable");
  }
  return undefined;
}
