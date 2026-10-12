import type * as z from "zod";
import { config } from "../../../config";
import { AppError } from "../../../shared/http";

/** Pinned so Stripe's responses keep the shape the schemas in `types.ts` expect. */
export const STRIPE_API_VERSION = "2026-09-30.endive";
const BASE_URL = "https://api.stripe.com";
const TIMEOUT_MS = 15_000;

/** Online payments need the platform key and the webhook secret: without the webhook nothing would ever confirm. */
export const stripeEnabled = () =>
  Boolean(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET);

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type Scalar = string | number | boolean;
export type FormParams = {
  [key: string]: Scalar | undefined | FormParams | (Scalar | FormParams)[];
};

/** Stripe's v1 bodies are form-encoded with bracketed keys: `a[b][0]=c`. */
export function encodeForm(
  params: FormParams,
  prefix?: string,
  out = new URLSearchParams(),
) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object") encodeForm(item, `${name}[${i}]`, out);
        else out.append(`${name}[${i}]`, String(item));
      });
    } else if (typeof value === "object") {
      encodeForm(value, name, out);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

type Request = {
  method: "GET" | "POST";
  path: string;
  form?: FormParams;
  json?: unknown;
  idempotencyKey?: string;
};

async function call<T extends z.ZodType>(
  schema: T,
  { method, path, form, json, idempotencyKey }: Request,
): Promise<z.output<T>> {
  const key = config.STRIPE_SECRET_KEY;
  if (!key) {
    throw new AppError(
      503,
      "ONLINE_PAYMENTS_DISABLED",
      "Online payments are off",
    );
  }
  const query = method === "GET" && form ? `?${encodeForm(form)}` : "";
  const body =
    json !== undefined
      ? JSON.stringify(json)
      : method === "POST" && form
        ? encodeForm(form).toString()
        : undefined;
  const res = await fetch(`${BASE_URL}${path}${query}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_API_VERSION,
      ...(body !== undefined && {
        "Content-Type":
          json !== undefined
            ? "application/json"
            : "application/x-www-form-urlencoded",
      }),
      ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (data as { error?: { code?: string; message?: string } })
      .error;
    throw new StripeError(
      res.status,
      error?.code,
      error?.message ?? `Stripe answered ${res.status}`,
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new StripeError(
      502,
      "unexpected_response",
      `Unexpected Stripe response for ${method} ${path}`,
    );
  }
  return parsed.data;
}

export const stripe = {
  get: <T extends z.ZodType>(schema: T, path: string, query?: FormParams) =>
    call(schema, { method: "GET", path, form: query }),
  post: <T extends z.ZodType>(
    schema: T,
    path: string,
    form: FormParams,
    idempotencyKey?: string,
  ) => call(schema, { method: "POST", path, form, idempotencyKey }),
  /** API v2 (`/v2/...`) takes JSON bodies. */
  postJson: <T extends z.ZodType>(
    schema: T,
    path: string,
    json: unknown,
    idempotencyKey?: string,
  ) => call(schema, { method: "POST", path, json, idempotencyKey }),
};

/** A Stripe failure as the API's stable error contract, logged without request data or keys. */
export function providerError(err: unknown, event: string) {
  if (err instanceof AppError) return err;
  console.error(
    JSON.stringify({
      level: "error",
      event,
      status: err instanceof StripeError ? err.status : undefined,
      code: err instanceof StripeError ? err.code : undefined,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  return new AppError(
    502,
    "PAYMENT_PROVIDER_ERROR",
    "The payment provider didn't answer, try again",
  );
}
