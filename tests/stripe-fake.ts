import { spyOn } from "bun:test";
import { ObjectId } from "mongodb";
import { app } from "../src/app";
import type { TenantDoc } from "../src/db/collections";
import { signPayload } from "../src/features/payments/stripe/signature";
import { bookingShop } from "./helpers";

export const WEBHOOK_SECRET = "whsec_test";

type Form = { [key: string]: string | Form };

/** Undoes Stripe's bracketed form encoding: `a[b][0]=c` → `{ a: { b: { "0": "c" } } }`. */
function parseForm(body: string): Form {
  const out: Form = {};
  for (const [key, value] of new URLSearchParams(body)) {
    const path = key.replace(/\]/g, "").split("[");
    let node = out;
    path.forEach((part, i) => {
      if (i === path.length - 1) node[part] = value;
      else {
        const next = node[part];
        node[part] = typeof next === "object" ? next : {};
        node = node[part] as Form;
      }
    });
  }
  return out;
}

const str = (form: Form, key: string) => {
  const value = form[key];
  return typeof value === "string" ? value : undefined;
};
const sub = (form: Form, key: string) => {
  const value = form[key];
  return typeof value === "object" ? value : {};
};

export type FakeIntent = {
  id: string;
  object: "payment_intent";
  status: string;
  amount: number;
  amount_received: number;
  currency: string;
  client_secret: string;
  customer: string | null;
  metadata: Record<string, string>;
  transfer_data: { destination: string };
  application_fee_amount: number;
  method: string;
  allowed: string[];
  next_action: unknown;
  latest_charge: {
    id: string;
    amount_refunded: number;
    payment_intent: string;
    transfer: string;
    payment_method_details: {
      type: string;
      card?: { brand: string; last4: string };
    };
  } | null;
};

let seq = 0;
const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * Stands in for api.stripe.com: answers the calls the backend makes and keeps their state, so tests
 * can move a payment forward (`succeed`, `fund`) and send the matching webhook.
 */
export function fakeStripe() {
  const intents = new Map<string, FakeIntent>();
  const accounts = new Map<string, { transfers: string; due: string[] }>();
  const refunds: { intent: string; amount: number; reverse: boolean }[] = [];
  /** The shop's share of each paid charge (destination charges) and what was taken back. */
  const transfers = new Map<
    string,
    { amount: number; amount_reversed: number }
  >();
  const reversals: { transfer: string; amount: number }[] = [];
  const calls: { method: string; path: string }[] = [];
  const state = { down: false };

  const transferInstructions = (pi: FakeIntent) => ({
    type: "display_bank_transfer_instructions",
    display_bank_transfer_instructions: {
      amount_remaining: pi.amount - pi.amount_received,
      currency: "mxn",
      reference: "123456",
      hosted_instructions_url: "https://payments.stripe.com/test",
      financial_addresses: [
        {
          type: "spei",
          spei: {
            bank_code: "002",
            bank_name: "BANAMEX",
            clabe: "002180650612345670",
          },
        },
      ],
    },
  });

  const handle = (method: string, url: URL, body: string) => {
    const path = url.pathname;
    calls.push({ method, path });
    if (state.down) return json(500, { error: { message: "down" } });
    if (method === "POST" && path === "/v2/core/accounts") {
      const accountId = id("acct");
      accounts.set(accountId, { transfers: "restricted", due: ["identity"] });
      return json(200, { id: accountId, object: "v2.core.account" });
    }
    if (method === "POST" && path === "/v2/core/account_links") {
      return json(200, { url: "https://connect.stripe.com/setup/test" });
    }
    const account = path.match(/^\/v2\/core\/accounts\/([^/]+)$/);
    if (method === "GET" && account?.[1]) {
      const found = accounts.get(account[1]) ?? {
        transfers: "active",
        due: [],
      };
      return json(200, {
        id: account[1],
        configuration: {
          recipient: {
            capabilities: {
              stripe_balance: { stripe_transfers: { status: found.transfers } },
            },
          },
        },
        requirements: {
          entries: found.due.map((description) => ({
            description,
            awaiting_action_from: "user",
            minimum_deadline: { status: "currently_due" },
          })),
        },
      });
    }
    if (
      method === "POST" &&
      /^\/v1\/accounts\/[^/]+\/login_links$/.test(path)
    ) {
      return json(200, { url: "https://connect.stripe.com/express/test" });
    }
    if (method === "POST" && path === "/v1/customers") {
      return json(200, { id: id("cus") });
    }
    if (method === "POST" && path === "/v1/payment_intents") {
      const form = parseForm(body);
      const allowed = str(sub(form, "allowed_payment_method_types"), "0");
      const transfer = allowed === "customer_balance";
      const pi: FakeIntent = {
        id: id("pi"),
        object: "payment_intent",
        status: transfer ? "requires_action" : "requires_payment_method",
        amount: Number(str(form, "amount")),
        amount_received: 0,
        currency: str(form, "currency") ?? "",
        client_secret: `secret_${seq}`,
        customer: str(form, "customer") ?? null,
        metadata: Object.fromEntries(
          Object.entries(sub(form, "metadata")).map(([k, v]) => [k, String(v)]),
        ),
        transfer_data: {
          destination: str(sub(form, "transfer_data"), "destination") ?? "",
        },
        application_fee_amount: Number(str(form, "application_fee_amount")),
        method: allowed ?? "",
        allowed: Object.values(sub(form, "allowed_payment_method_types")).map(
          String,
        ),
        next_action: null,
        latest_charge: null,
      };
      if (transfer) pi.next_action = transferInstructions(pi);
      intents.set(pi.id, pi);
      return json(200, pi);
    }
    const intent = path.match(/^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/);
    if (intent?.[1]) {
      const pi = intents.get(intent[1]);
      if (!pi) return json(404, { error: { code: "resource_missing" } });
      if (intent[2]) {
        if (pi.status === "succeeded") {
          return json(400, {
            error: { code: "payment_intent_unexpected_state" },
          });
        }
        pi.status = "canceled";
      }
      return json(200, pi);
    }
    const transfer = path.match(/^\/v1\/transfers\/([^/]+)(\/reversals)?$/);
    if (transfer?.[1]) {
      const found = transfers.get(transfer[1]);
      if (!found) return json(404, { error: { code: "resource_missing" } });
      if (method === "POST" && transfer[2]) {
        const amount = Number(str(parseForm(body), "amount"));
        if (amount > found.amount - found.amount_reversed) {
          return json(400, { error: { code: "amount_too_large" } });
        }
        found.amount_reversed += amount;
        reversals.push({ transfer: transfer[1], amount });
        return json(200, { id: id("trr"), amount });
      }
      return json(200, { id: transfer[1], ...found });
    }
    if (method === "POST" && path === "/v1/refunds") {
      const form = parseForm(body);
      const intentId = str(form, "payment_intent") ?? "";
      const amount = Number(str(form, "amount"));
      refunds.push({
        intent: intentId,
        amount,
        reverse: str(form, "reverse_transfer") === "true",
      });
      const pi = intents.get(intentId);
      if (pi?.latest_charge) pi.latest_charge.amount_refunded += amount;
      return json(200, { id: id("re"), amount, status: "succeeded" });
    }
    return json(404, { error: { message: `no fake for ${method} ${path}` } });
  };

  const original = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.stripe.com") return original(input, init);
    return handle(
      init?.method ?? "GET",
      url,
      typeof init?.body === "string" ? init.body : "",
    );
  }) as typeof fetch);

  const charge = (pi: FakeIntent) => {
    const transferId = id("tr");
    transfers.set(transferId, {
      amount: pi.amount - pi.application_fee_amount,
      amount_reversed: 0,
    });
    return {
      // Like Stripe: a card charge is `ch_…`, a bank transfer from the customer balance `py_…`.
      id: id(pi.method === "customer_balance" ? "py" : "ch"),
      amount_refunded: 0,
      payment_intent: pi.id,
      transfer: transferId,
      payment_method_details:
        pi.method === "customer_balance"
          ? { type: "customer_balance" }
          : { type: "card", card: { brand: "visa", last4: "4242" } },
    };
  };

  return {
    intents,
    accounts,
    refunds,
    transfers,
    reversals,
    calls,
    state,
    restore: () => spy.mockRestore(),
    intent: (intentId: string) => {
      const pi = intents.get(intentId);
      if (!pi) throw new Error(`no intent ${intentId}`);
      return pi;
    },
    /** The customer pays the whole amount (card confirmed, or transfer received). */
    succeed(intentId: string) {
      const pi = this.intent(intentId);
      pi.status = "succeeded";
      pi.amount_received = pi.amount;
      pi.next_action = null;
      pi.latest_charge = charge(pi);
      return pi;
    },
    /** A transfer for less than the amount: still waiting, with what is left. */
    fund(intentId: string, amount: number) {
      const pi = this.intent(intentId);
      pi.amount_received += amount;
      pi.next_action = transferInstructions(pi);
      return pi;
    },
  };
}

export type FakeStripe = ReturnType<typeof fakeStripe>;

/** Delivers a signed webhook, as Stripe would. */
export async function sendEvent(
  event: Record<string, unknown>,
  secret = WEBHOOK_SECRET,
) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const res = await app.request("/webhooks/stripe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": `t=${t},v1=${signPayload(payload, secret, t)}`,
    },
    body: payload,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

export const intentEvent = (type: string, pi: FakeIntent) => ({
  id: id("evt"),
  object: "event",
  type,
  data: { object: pi },
});

/** A shop whose connected account Stripe already approved. */
export function stripeShop(
  overrides: { deposit?: TenantDoc["deposit"] } = {},
  options: Parameters<typeof bookingShop>[0] = {},
) {
  const now = new Date();
  return bookingShop({
    ...options,
    tenant: {
      stripeConnect: {
        accountId: `acct_${new ObjectId().toHexString()}`,
        status: "active",
        requirementsDue: [],
        createdAt: now,
        updatedAt: now,
      },
      ...(overrides.deposit && { deposit: overrides.deposit }),
      ...options.tenant,
    },
  });
}
