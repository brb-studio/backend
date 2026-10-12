import type { ObjectId } from "mongodb";
import { db } from "./client";
import type { CollectionSpec } from "./setup";
import {
  CURRENCY,
  date,
  int,
  MONEY,
  object,
  objectId,
  oneOf,
  string,
} from "./validators";

/** States of a transfer confirmed by hand: appointment SPEI payments and the barbershops' subscription payments. */
export const PAYMENT_STATUSES = [
  "pending",
  "paid",
  "rejected",
  "expired",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * Appointment payments add Stripe's outcomes: `awaiting_transfer` (Stripe gave a CLABE and waits for the
 * money), `refunded` (whole amount returned) and `disputed` (the cardholder opened a chargeback).
 */
export const APPOINTMENT_PAYMENT_STATUSES = [
  ...PAYMENT_STATUSES,
  "awaiting_transfer",
  "refunded",
  "disputed",
] as const;
export type AppointmentPaymentDocStatus =
  (typeof APPOINTMENT_PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ["spei", "card", "bank_transfer"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_KINDS = ["deposit", "full"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** What Stripe told us about an online payment. Never card numbers: only brand and last 4 digits. */
export type StripePaymentInfo = {
  /** The connected account (the barbershop) the charge is transferred to. */
  accountId: string;
  /** Set right after Stripe creates it; absent only between the booking transaction and that call. */
  paymentIntentId?: string;
  /** Bank transfers need a Stripe Customer: Stripe gives each one its own CLABE. */
  customerId?: string;
  /** Kept by the platform to cover Stripe's fee (plus `debtMinor`); the barbershop receives the rest. */
  applicationFeeMinor: number;
  /** Part of `applicationFeeMinor` that pays down the shop's fee debt (not Stripe's fee for this payment). */
  debtMinor?: number;
  /** Taken back from the shop's transfer for refunds. */
  reversedMinor?: number;
  receivedMinor?: number;
  refundedMinor?: number;
  cardBrand?: string;
  cardLast4?: string;
  /** Where to send the transfer (`bank_transfer` only), as Stripe gave it. */
  instructions?: {
    clabe: string;
    bankName?: string;
    reference?: string;
    hostedUrl?: string;
    amountRemainingMinor: number;
  };
  disputeId?: string;
};

/**
 * Money a customer owes for one appointment. `spei` is a manual transfer to the barbershop's own CLABE,
 * confirmed by hand; `card` and `bank_transfer` go through Stripe and are confirmed by its webhook.
 */
export type PaymentDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  appointmentId: ObjectId;
  method: PaymentMethod;
  status: AppointmentPaymentDocStatus;
  /** Online payments only: the deposit or the whole visit. A manual transfer is always the whole visit. */
  kind?: PaymentKind;
  amountMinor: number;
  currency: string;
  /** Manual only: the account shown to the customer, frozen at creation so later edits can't redirect a payment in flight. */
  bank?: { clabe: string; holder: string };
  stripe?: StripePaymentInfo;
  createdAt: Date;
  expiresAt: Date;
  /** Transfer tracking key (clave de rastreo) typed by whoever confirmed it. */
  reference?: string;
  resolvedAt?: Date;
  resolvedBy?: ObjectId;
  rejectionReason?: string;
  /** Every transition, oldest first. */
  history: {
    status: AppointmentPaymentDocStatus;
    at: Date;
    by?: ObjectId;
    note?: string;
  }[];
};

/** A Stripe event already handled; its unique id makes a redelivered event a no-op. */
export type StripeEventDoc = {
  _id: string;
  type: string;
  receivedAt: Date;
};

export const payments = db.collection<PaymentDoc>("payments");
export const stripeEvents = db.collection<StripeEventDoc>("stripeEvents");

const history = {
  bsonType: "array",
  minItems: 1,
  items: object(["status", "at"], {
    status: oneOf(APPOINTMENT_PAYMENT_STATUSES),
    at: date,
    by: objectId,
    note: string({ maxLength: 500 }),
  }),
};

export const paymentSpecs: CollectionSpec[] = [
  {
    name: "payments",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "appointmentId",
          "method",
          "status",
          "amountMinor",
          "currency",
          "createdAt",
          "expiresAt",
          "history",
        ],
        {
          tenantId: objectId,
          appointmentId: objectId,
          method: oneOf(PAYMENT_METHODS),
          status: oneOf(APPOINTMENT_PAYMENT_STATUSES),
          kind: oneOf(PAYMENT_KINDS),
          amountMinor: int(1, 100_000_000),
          currency: CURRENCY,
          bank: object(["clabe", "holder"], {
            clabe: string({ pattern: "^\\d{18}$" }),
            holder: string({ minLength: 1, maxLength: 120 }),
          }),
          stripe: object(["accountId", "applicationFeeMinor"], {
            accountId: string({ pattern: "^acct_" }),
            paymentIntentId: string({ pattern: "^pi_" }),
            customerId: string({ pattern: "^cus_" }),
            applicationFeeMinor: MONEY,
            debtMinor: MONEY,
            reversedMinor: MONEY,
            receivedMinor: MONEY,
            refundedMinor: MONEY,
            cardBrand: string({ maxLength: 40 }),
            cardLast4: string({ pattern: "^\\d{4}$" }),
            instructions: object(["clabe", "amountRemainingMinor"], {
              clabe: string({ pattern: "^\\d{18}$" }),
              amountRemainingMinor: MONEY,
            }),
            disputeId: string({ pattern: "^du_" }),
          }),
          createdAt: date,
          expiresAt: date,
          reference: string({ maxLength: 120 }),
          resolvedAt: date,
          resolvedBy: objectId,
          rejectionReason: string({ maxLength: 500 }),
          history,
        },
      ),
      // A manual transfer always carries the account it was sent to; an online one, Stripe's data.
      $or: [
        { method: "spei", bank: { $exists: true } },
        { method: { $ne: "spei" }, stripe: { $exists: true } },
      ],
    },
    indexes: [
      // One open payment per appointment: the database refuses a second one.
      {
        key: { appointmentId: 1 },
        name: "appointment_open_unique",
        unique: true,
        partialFilterExpression: {
          status: { $in: ["pending", "awaiting_transfer"] },
        },
      },
      { key: { tenantId: 1, status: 1, createdAt: -1 }, name: "tenant_status" },
      // The webhook finds the payment by Stripe's id.
      {
        key: { "stripe.paymentIntentId": 1 },
        name: "stripe_intent_unique",
        unique: true,
        partialFilterExpression: {
          "stripe.paymentIntentId": { $type: "string" },
        },
      },
    ],
    /** Replaced by `appointment_open_unique`, which also covers transfers waiting at Stripe. */
    dropIndexes: ["appointment_pending_unique"],
  },
  {
    name: "stripeEvents",
    validator: {
      $jsonSchema: object(["type", "receivedAt"], {
        _id: string({ pattern: "^evt_" }),
        type: string({ maxLength: 200 }),
        receivedAt: date,
      }),
    },
    indexes: [
      // Stripe stops redelivering after 3 days; a month of ids is plenty to catch duplicates.
      {
        key: { receivedAt: 1 },
        name: "received_ttl",
        expireAfterSeconds: 30 * 24 * 60 * 60,
      },
    ],
  },
];
