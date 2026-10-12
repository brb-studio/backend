import * as z from "zod";

/**
 * The parts of Stripe's objects this app reads. Loose objects: Stripe adds fields over time, and every
 * response and webhook payload is checked against these before use.
 */
const metadata = z.record(z.string(), z.string()).default({});

export const account = z.looseObject({
  id: z.string().startsWith("acct_"),
  configuration: z
    .looseObject({
      recipient: z
        .looseObject({
          capabilities: z
            .looseObject({
              stripe_balance: z
                .looseObject({
                  stripe_transfers: z
                    .looseObject({ status: z.string() })
                    .nullish(),
                })
                .nullish(),
            })
            .nullish(),
        })
        .nullish(),
    })
    .nullish(),
  requirements: z
    .looseObject({
      entries: z
        .array(
          z.looseObject({
            description: z.string(),
            awaiting_action_from: z.string().nullish(),
            minimum_deadline: z.looseObject({ status: z.string() }).nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});
export type StripeAccount = z.output<typeof account>;

export const accountLink = z.looseObject({ url: z.url() });
export const loginLink = z.looseObject({ url: z.url() });
export const customer = z.looseObject({ id: z.string().startsWith("cus_") });

const transferInstructions = z.looseObject({
  amount_remaining: z.number().int(),
  reference: z.string().nullish(),
  hosted_instructions_url: z.string().nullish(),
  financial_addresses: z
    .array(
      z.looseObject({
        type: z.string(),
        spei: z
          .looseObject({ clabe: z.string(), bank_name: z.string().nullish() })
          .nullish(),
      }),
    )
    .default([]),
});

const charge = z.looseObject({
  // Cards are `ch_…`; bank transfers paid from the customer balance are `py_…`.
  id: z.string().min(1),
  amount_refunded: z.number().int().default(0),
  payment_intent: z.string().nullish(),
  /** Destination charges: the transfer that sent the shop its share. */
  transfer: z.string().nullish(),
  payment_method_details: z
    .looseObject({
      card: z
        .looseObject({
          brand: z.string().nullish(),
          last4: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
export type StripeCharge = z.output<typeof charge>;

export const paymentIntent = z.looseObject({
  id: z.string().startsWith("pi_"),
  status: z.string(),
  amount: z.number().int(),
  amount_received: z.number().int().default(0),
  currency: z.string(),
  client_secret: z.string().nullish(),
  metadata,
  customer: z.string().nullish(),
  latest_charge: z.union([z.string(), charge]).nullish(),
  transfer_data: z.looseObject({ destination: z.string() }).nullish(),
  next_action: z
    .looseObject({
      type: z.string(),
      display_bank_transfer_instructions: transferInstructions.nullish(),
    })
    .nullish(),
});
export type StripePaymentIntent = z.output<typeof paymentIntent>;

export { charge };

export const refund = z.looseObject({
  id: z.string(),
  amount: z.number().int(),
  status: z.string().nullish(),
});

export const transfer = z.looseObject({
  id: z.string().startsWith("tr_"),
  amount: z.number().int(),
  amount_reversed: z.number().int().default(0),
});

export const transferReversal = z.looseObject({
  id: z.string(),
  amount: z.number().int(),
});

export const dispute = z.looseObject({
  id: z.string().startsWith("du_"),
  amount: z.number().int(),
  charge: z.string(),
  payment_intent: z.string().nullish(),
});

/** Snapshot events (`object: "event"`): the full object as it was when the event happened. */
export const snapshotEvent = z.looseObject({
  id: z.string().startsWith("evt_"),
  object: z.literal("event"),
  type: z.string(),
  account: z.string().nullish(),
  data: z.looseObject({ object: z.unknown() }),
});

/** Thin events (`object: "v2.core.event"`): only the type and the related object's id. */
export const thinEvent = z.looseObject({
  id: z.string().startsWith("evt_"),
  object: z.literal("v2.core.event"),
  type: z.string(),
  related_object: z.looseObject({ id: z.string(), type: z.string() }).nullish(),
});

export const event = z.union([snapshotEvent, thinEvent]);
