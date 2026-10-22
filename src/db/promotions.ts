import type { ObjectId } from "mongodb";
import { db } from "./client";
import type { Localized } from "./collections";
import type { CollectionSpec } from "./setup";
import { bool, date, int, object, objectId, oneOf, string } from "./validators";

export type PromotionSnapshot = {
  promotionId: ObjectId;
  code?: string;
  name: Localized;
  type: "percent" | "fixed";
  value: number;
  amountMinor: number;
};

export type PromotionDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  name: Localized;
  code?: string;
  type: "percent" | "fixed";
  value: number;
  startsAt?: Date;
  endsAt?: Date;
  branchIds: ObjectId[];
  serviceIds: ObjectId[];
  packageIds: ObjectId[];
  minSubtotalMinor?: number;
  firstVisitOnly: boolean;
  everyVisits?: number;
  maxRedemptions?: number;
  maxPerCustomer?: number;
  redemptions: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const promotions = db.collection<PromotionDoc>("promotions");

export const promotionSpecs: CollectionSpec[] = [
  {
    name: "promotions",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "name",
          "type",
          "value",
          "branchIds",
          "serviceIds",
          "packageIds",
          "firstVisitOnly",
          "redemptions",
          "active",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          name: { bsonType: "object" },
          code: string({ pattern: "^[A-Z0-9_-]{3,32}$" }),
          type: oneOf(["percent", "fixed"]),
          value: int(1, 10_000_000),
          startsAt: date,
          endsAt: date,
          branchIds: { bsonType: "array", items: objectId },
          serviceIds: { bsonType: "array", items: objectId },
          packageIds: { bsonType: "array", items: objectId },
          minSubtotalMinor: int(0, 100_000_000),
          firstVisitOnly: bool,
          everyVisits: int(2, 100),
          maxRedemptions: int(1, 10_000_000),
          maxPerCustomer: int(1, 1000),
          redemptions: int(0, 10_000_000),
          active: bool,
          createdAt: date,
          updatedAt: date,
        },
      ),
      $expr: {
        $or: [{ $ne: ["$type", "percent"] }, { $lte: ["$value", 100] }],
      },
    },
    indexes: [
      {
        key: { tenantId: 1, code: 1 },
        name: "tenant_code_unique",
        unique: true,
        partialFilterExpression: { code: { $type: "string" } },
      },
    ],
  },
];
