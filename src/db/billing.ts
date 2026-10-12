import type { ObjectId } from "mongodb";
import { db } from "./client";
import { PAYMENT_STATUSES, type PaymentStatus } from "./payments";
import type { CollectionSpec } from "./setup";
import {
  date,
  int,
  object,
  objectId,
  oneOf,
  REFERRAL_CODE,
  string,
} from "./validators";

/**
 * The project owner's account: the one that receives the barbershops' subscription transfers. Edited by
 * hand in the database; the app only reads it (`name` is the account holder).
 */
export type OwnerProjectDoc = {
  _id: ObjectId;
  email: string;
  name: string;
  role: "owner";
  active: boolean;
  bankAccountKey?: string;
};

/** A barbershop's SPEI transfer for one month of the app; platform staff confirm it by hand. */
export type SubscriptionPaymentDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  status: PaymentStatus;
  /** What the owner must transfer: list price, minus the referral discount, minus credit used. */
  amountMinor: number;
  listPriceMinor: number;
  discountMinor: number;
  creditAppliedMinor: number;
  currency: string;
  bank: { clabe: string; holder: string };
  /** Present when a friend's code gave the first-month discount; the referrer is rewarded on confirmation. */
  referral?: {
    referrerTenantId: ObjectId;
    code: string;
    discountPercent: number;
  };
  createdAt: Date;
  expiresAt: Date;
  reference?: string;
  resolvedAt?: Date;
  /** Platform staff who resolved it; absent when credit covered the whole price. */
  resolvedBy?: ObjectId;
  rejectionReason?: string;
  history: { status: PaymentStatus; at: Date; by?: ObjectId; note?: string }[];
};

export const ownerProject = db.collection<OwnerProjectDoc>("ownerProject");
export const subscriptionPayments = db.collection<SubscriptionPaymentDoc>(
  "subscriptionPayments",
);

export const billingSpecs: CollectionSpec[] = [
  {
    name: "subscriptionPayments",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "status",
          "amountMinor",
          "listPriceMinor",
          "discountMinor",
          "creditAppliedMinor",
          "currency",
          "bank",
          "createdAt",
          "expiresAt",
          "history",
        ],
        {
          tenantId: objectId,
          status: oneOf(PAYMENT_STATUSES),
          amountMinor: int(0, 100_000_000),
          listPriceMinor: int(1, 100_000_000),
          discountMinor: int(0, 100_000_000),
          creditAppliedMinor: int(0, 100_000_000),
          currency: string({ pattern: "^[A-Z]{3}$" }),
          bank: object(["clabe", "holder"], {
            clabe: string({ pattern: "^\\d{18}$" }),
            holder: string({ minLength: 1, maxLength: 120 }),
          }),
          referral: object(["referrerTenantId", "code", "discountPercent"], {
            referrerTenantId: objectId,
            code: string({ pattern: REFERRAL_CODE }),
            discountPercent: int(1, 100),
          }),
          createdAt: date,
          expiresAt: date,
          reference: string({ maxLength: 120 }),
          resolvedAt: date,
          resolvedBy: objectId,
          rejectionReason: string({ maxLength: 500 }),
          history: {
            bsonType: "array",
            minItems: 1,
            items: object(["status", "at"], {
              status: oneOf(PAYMENT_STATUSES),
              at: date,
              by: objectId,
              note: string({ maxLength: 500 }),
            }),
          },
        },
      ),
    },
    indexes: [
      // One open subscription transfer per barbershop.
      {
        key: { tenantId: 1 },
        name: "tenant_pending_unique",
        unique: true,
        partialFilterExpression: { status: "pending" },
      },
      { key: { status: 1, createdAt: -1 }, name: "status_created" },
    ],
  },
];
