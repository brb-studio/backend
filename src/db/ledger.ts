import type { ObjectId } from "mongodb";
import { db } from "./client";
import type { CollectionSpec } from "./setup";
import {
  bool,
  CURRENCY,
  date,
  int,
  object,
  objectId,
  oneOf,
  string,
} from "./validators";

export const LEDGER_DIRECTIONS = ["in", "out"] as const;
export const LEDGER_TYPES = [
  "service_payment",
  "product_sale",
  "refund",
  "chargeback",
  "online_fee",
  "payout",
  "expense",
  "adjustment",
] as const;
export const LEDGER_METHODS = ["cash", "card", "transfer"] as const;
export const LEDGER_CHANNELS = ["counter", "online", "spei"] as const;

export type LedgerDirection = (typeof LEDGER_DIRECTIONS)[number];
export type LedgerType = (typeof LEDGER_TYPES)[number];
export type LedgerMethod = (typeof LEDGER_METHODS)[number];
export type LedgerChannel = (typeof LEDGER_CHANNELS)[number];

export type LedgerEntryDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  branchId: ObjectId;
  source: string;
  at: Date;
  localDate: string;
  direction: LedgerDirection;
  type: LedgerType;
  method?: LedgerMethod;
  channel?: LedgerChannel;
  amountMinor: number;
  currency: string;
  concept: string;
  customerId?: ObjectId;
  appointmentId?: ObjectId;
  productOrderId?: ObjectId;
  paymentId?: ObjectId;
  payoutId?: ObjectId;
  reference?: string;
  recordedBy?: ObjectId;
  reverses?: ObjectId;
  note?: string;
  approximate?: boolean;
  createdAt: Date;
};

export const ledgerEntries = db.collection<LedgerEntryDoc>("ledgerEntries");

export const ledgerSpecs: CollectionSpec[] = [
  {
    name: "ledgerEntries",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "branchId",
          "source",
          "at",
          "localDate",
          "direction",
          "type",
          "amountMinor",
          "currency",
          "concept",
          "createdAt",
        ],
        {
          tenantId: objectId,
          branchId: objectId,
          source: string({ minLength: 1, maxLength: 200 }),
          at: date,
          localDate: string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
          direction: oneOf(LEDGER_DIRECTIONS),
          type: oneOf(LEDGER_TYPES),
          method: oneOf(LEDGER_METHODS),
          channel: oneOf(LEDGER_CHANNELS),
          amountMinor: int(1, 1_000_000_000),
          currency: CURRENCY,
          concept: string({ maxLength: 300 }),
          customerId: objectId,
          appointmentId: objectId,
          productOrderId: objectId,
          paymentId: objectId,
          payoutId: objectId,
          reference: string({ maxLength: 120 }),
          recordedBy: objectId,
          reverses: objectId,
          note: string({ maxLength: 500 }),
          approximate: bool,
          createdAt: date,
        },
      ),
    },
    indexes: [
      {
        key: { tenantId: 1, source: 1 },
        name: "tenant_source_unique",
        unique: true,
      },
      { key: { tenantId: 1, localDate: 1, at: 1 }, name: "tenant_day_at" },
      {
        key: { tenantId: 1, branchId: 1, localDate: 1 },
        name: "tenant_branch_day",
      },
      {
        key: { tenantId: 1, reverses: 1 },
        name: "tenant_reverses_unique",
        unique: true,
        partialFilterExpression: { reverses: { $type: "objectId" } },
      },
    ],
  },
];
