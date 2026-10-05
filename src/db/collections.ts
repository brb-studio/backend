import type { Binary, Document, ObjectId } from "mongodb";
import { db } from "./client";
import type { CollectionSpec } from "./setup";

export const LOCALES = ["es", "en"] as const;
export const ROLES = [
  "owner",
  "admin",
  "manager",
  "barber",
  "customer",
] as const;
export const PLANS = ["trial", "basic", "pro", "lifetime"] as const;
export const STATUSES = ["trialing", "active", "past_due", "canceled"] as const;

export type Locale = (typeof LOCALES)[number];
export type Role = (typeof ROLES)[number];
export type Plan = (typeof PLANS)[number];
export type ThemeValue = string | { light: string; dark: string };

export type TenantDoc = {
  _id: ObjectId;
  slug: string;
  name: string;
  customDomain?: string;
  currency: string;
  locales: Locale[];
  defaultLocale: Locale;
  theme?: Record<string, ThemeValue>;
  brand: { instagramUrl?: string; authImage?: string; coverImage?: string };
  subscription: {
    plan: Plan;
    status: (typeof STATUSES)[number];
    currentPeriodEnd?: Date;
    limits: { branches: number; barbers: number };
  };
  stripe?: {
    accountId: string;
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    onboardedAt?: Date;
  };
  /**
   * The barbershop paying us (Stripe Billing on the platform account), unlike `stripe`, which is the
   * Connect account its customers pay. `firstPaidAt` marks the first paid month (referral codes need it).
   */
  billing?: {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    firstPaidAt?: Date;
  };
  /** The code this tenant shares with other barbershops. */
  referralCode?: string;
  createdAt: Date;
  updatedAt: Date;
};

export const REFERRAL_STATUSES = ["pending", "rewarded", "skipped"] as const;

/** One barbershop bringing another; at most one per referee, ever. */
export type ReferralDoc = {
  _id: ObjectId;
  referrerTenantId: ObjectId;
  refereeTenantId: ObjectId;
  code: string;
  discountPercent: number;
  status: (typeof REFERRAL_STATUSES)[number];
  checkoutSessionId: string;
  currency: string;
  subtotalMinor: number;
  rewardMinor: number;
  stripeBalanceTransactionId?: string;
  createdAt: Date;
  rewardedAt?: Date;
};

export type Hours = { weekday: number; open: string; close: string };

export type BookingRules = {
  slotIntervalMin: number;
  bufferMin: number;
  minNoticeMin: number;
  windowDays: number;
  cancelNoticeMin: number;
};

export type BranchDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  slug: string;
  name: string;
  address: string[];
  phone?: string;
  mapsUrl?: string;
  image?: string;
  images?: string[];
  timeZone: string;
  hours: Hours[];
  booking: BookingRules;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type UserDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  email: string;
  passwordHash: string;
  name: string;
  phone?: string;
  role: Role;
  branchId?: ObjectId;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionDoc = {
  _id: string;
  tenantId: ObjectId;
  userId: ObjectId;
  expiresAt: Date;
  createdAt: Date;
};

export type Localized = Partial<Record<Locale, string>>;

export type BarberDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  branchId: ObjectId;
  userId?: ObjectId;
  slug: string;
  name: string;
  specialty?: Localized;
  bio?: Localized;
  image?: string;
  /** Photos, cover first (`image` is the single photo of older documents). */
  images?: string[];
  hours: Hours[];
  serviceIds: ObjectId[];
  active: boolean;
  lockVersion?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ServiceDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  branchId?: ObjectId;
  slug: string;
  name: Localized;
  description?: Localized;
  durationMin: number;
  priceMinor: number;
  image?: string;
  /** Photos, cover first (`image` is the single photo of older documents). */
  images?: string[];
  position: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PackageDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  branchId?: ObjectId;
  slug: string;
  name: Localized;
  description?: Localized;
  priceMinor: number;
  items: { serviceId: ObjectId }[];
  image?: string;
  /** Photos, cover first (`image` is the single photo of older documents). */
  images?: string[];
  position: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const TIME_OFF_KINDS = [
  "break",
  "time_off",
  "vacation",
  "block",
  "closure",
] as const;

export type TimeOffDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  branchId: ObjectId;
  barberId?: ObjectId;
  startAt: Date;
  endAt: Date;
  kind: (typeof TIME_OFF_KINDS)[number];
  reason?: string;
  createdBy: ObjectId;
  createdAt: Date;
};

export const tenants = db.collection<TenantDoc>("tenants");
export const referrals = db.collection<ReferralDoc>("referrals");
export const branches = db.collection<BranchDoc>("branches");
export const users = db.collection<UserDoc>("users");
export const sessions = db.collection<SessionDoc>("sessions");

/** One fixed rate-limit window; `_id` is the hashed key (no emails or phones stored). */
export type RateLimitDoc = { _id: string; count: number; expiresAt: Date };
export const rateLimits = db.collection<RateLimitDoc>("rateLimits");
export const barbers = db.collection<BarberDoc>("barbers");
export const timeOff = db.collection<TimeOffDoc>("timeOff");
export const services = db.collection<ServiceDoc>("services");
export const packages = db.collection<PackageDoc>("packages");

export type CustomerDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  userId?: ObjectId;
  name: string;
  phone?: string;
  email?: string;
  createdAt: Date;
  updatedAt: Date;
};

export const APPOINTMENT_STATUSES = [
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export type AppointmentItem =
  | {
      kind: "service";
      serviceId: ObjectId;
      name: Localized;
      durationMin: number;
      priceMinor: number;
    }
  | {
      kind: "package";
      packageId: ObjectId;
      name: Localized;
      durationMin: number;
      priceMinor: number;
      services: {
        serviceId: ObjectId;
        name: Localized;
        durationMin: number;
        listPriceMinor: number;
      }[];
    };

export type PromotionSnapshot = {
  promotionId: ObjectId;
  code?: string;
  name: Localized;
  type: "percent" | "fixed";
  value: number;
  amountMinor: number;
};

export type AppointmentPaymentStatus =
  | "requires_payment"
  | "paid"
  | "refunded"
  | "failed";

export type AppointmentDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  branchId: ObjectId;
  barberId: ObjectId;
  customerId: ObjectId;
  status: AppointmentStatus;
  startAt: Date;
  endAt: Date;
  blockedUntil: Date;
  timeZone: string;
  items: AppointmentItem[];
  currency: string;
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  promotion?: PromotionSnapshot;
  payment?: {
    provider: "stripe";
    intentId: string;
    status: AppointmentPaymentStatus;
    amountMinor: number;
    applicationFeeMinor?: number;
    paidAt?: Date;
  };
  notes?: string;
  source: "online" | "staff";
  createdBy?: ObjectId;
  cancelledAt?: Date;
  cancelledBy?: ObjectId;
  cancelReason?: string;
  createdAt: Date;
  updatedAt: Date;
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
  maxRedemptions?: number;
  maxPerCustomer?: number;
  redemptions: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export const customers = db.collection<CustomerDoc>("customers");
export const appointments = db.collection<AppointmentDoc>("appointments");
export const promotions = db.collection<PromotionDoc>("promotions");

export const NOTIFICATION_TYPES = [
  "appointment.booked",
  "appointment.cancelled",
  "appointment.rescheduled",
] as const;

export type NotificationDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  userId: ObjectId;
  type: (typeof NOTIFICATION_TYPES)[number];
  appointmentId: ObjectId;
  summary: {
    start: string;
    timeZone: string;
    customerName: string;
    items: Localized[];
    branchName: string;
  };
  readAt?: Date;
  createdAt: Date;
};

export const notifications = db.collection<NotificationDoc>("notifications");

export type ImageDoc = {
  _id: string;
  tenantId: ObjectId;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  data: Binary;
  size: number;
  createdBy: ObjectId;
  createdAt: Date;
};
export const images = db.collection<ImageDoc>("images");

export type PushSubscriptionDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  userId: ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: Date;
  updatedAt: Date;
};

export const pushSubscriptions =
  db.collection<PushSubscriptionDoc>("pushSubscriptions");

const string = (extra: Document = {}) => ({ bsonType: "string", ...extra });
const int = (minimum: number, maximum: number) => ({
  bsonType: "int",
  minimum,
  maximum,
});
const objectId = { bsonType: "objectId" };
const date = { bsonType: "date" };
const bool = { bsonType: "bool" };
const oneOf = (values: readonly string[]) => ({ enum: [...values] });
const object = (required: string[], properties: Document) => ({
  bsonType: "object",
  required,
  properties,
});
const HHMM = "^([01]\\d|2[0-3]):[0-5]\\d$";
const REFERRAL_CODE = "^[A-HJ-NP-Z2-9]{8}$";
const timestamps = { createdAt: date, updatedAt: date };
const localized = { bsonType: "object" };
const hours = {
  bsonType: "array",
  items: object(["weekday", "open", "close"], {
    weekday: int(0, 6),
    open: string({ pattern: HHMM }),
    close: string({ pattern: HHMM }),
  }),
};
const opensBeforeCloses = {
  $allElementsTrue: [
    { $map: { input: "$hours", in: { $lt: ["$$this.open", "$$this.close"] } } },
  ],
};

export const specs: CollectionSpec[] = [
  {
    name: "tenants",
    validator: {
      $jsonSchema: object(
        [
          "slug",
          "name",
          "currency",
          "locales",
          "defaultLocale",
          "brand",
          "subscription",
          "createdAt",
          "updatedAt",
        ],
        {
          slug: string(),
          name: string(),
          customDomain: string(),
          currency: string({ pattern: "^[A-Z]{3}$" }),
          locales: { bsonType: "array", minItems: 1, items: oneOf(LOCALES) },
          defaultLocale: oneOf(LOCALES),
          theme: { bsonType: "object" },
          brand: { bsonType: "object" },
          subscription: object(["plan", "status", "limits"], {
            plan: oneOf(PLANS),
            status: oneOf(STATUSES),
            currentPeriodEnd: date,
            limits: object(["branches", "barbers"], {
              branches: int(0, 1000),
              barbers: int(0, 10_000),
            }),
          }),
          stripe: object(["accountId", "detailsSubmitted", "chargesEnabled"], {
            accountId: string({ pattern: "^acct_" }),
            detailsSubmitted: bool,
            chargesEnabled: bool,
            onboardedAt: date,
          }),
          billing: {
            bsonType: "object",
            properties: {
              stripeCustomerId: string({ pattern: "^cus_\\w+$" }),
              stripeSubscriptionId: string({ pattern: "^sub_\\w+$" }),
              firstPaidAt: date,
            },
          },
          referralCode: string({ pattern: REFERRAL_CODE }),
          ...timestamps,
        },
      ),
    },
    indexes: [
      { key: { slug: 1 }, name: "slug_unique", unique: true },
      {
        key: { customDomain: 1 },
        name: "customDomain_unique",
        unique: true,
        partialFilterExpression: { customDomain: { $type: "string" } },
      },
      {
        key: { "stripe.accountId": 1 },
        name: "stripe_account_unique",
        unique: true,
        partialFilterExpression: { "stripe.accountId": { $type: "string" } },
      },
      {
        key: { referralCode: 1 },
        name: "referralCode_unique",
        unique: true,
        partialFilterExpression: { referralCode: { $type: "string" } },
      },
      {
        key: { "billing.stripeCustomerId": 1 },
        name: "stripeCustomer_unique",
        unique: true,
        partialFilterExpression: {
          "billing.stripeCustomerId": { $type: "string" },
        },
      },
    ],
  },
  {
    name: "branches",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "slug",
          "name",
          "address",
          "timeZone",
          "hours",
          "booking",
          "active",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          slug: string(),
          name: string(),
          address: { bsonType: "array", items: string() },
          phone: string(),
          mapsUrl: string(),
          image: string(),
          images: { bsonType: "array", maxItems: 12, items: string() },
          timeZone: string(),
          hours,
          booking: object(
            [
              "slotIntervalMin",
              "bufferMin",
              "minNoticeMin",
              "windowDays",
              "cancelNoticeMin",
            ],
            {
              slotIntervalMin: int(5, 240),
              bufferMin: int(0, 120),
              minNoticeMin: int(0, 10_080),
              windowDays: int(1, 365),
              cancelNoticeMin: int(0, 10_080),
            },
          ),
          active: bool,
          ...timestamps,
        },
      ),
      $expr: opensBeforeCloses,
    },
    indexes: [
      {
        key: { tenantId: 1, slug: 1 },
        name: "tenant_slug_unique",
        unique: true,
      },
    ],
  },
  {
    name: "users",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "email",
          "passwordHash",
          "name",
          "role",
          "active",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          email: string({ pattern: "^[^A-Z\\s]+@[^A-Z\\s]+$" }),
          passwordHash: string({ pattern: "^\\$argon2id\\$" }),
          name: string(),
          phone: string(),
          role: oneOf(ROLES),
          branchId: objectId,
          active: bool,
          ...timestamps,
        },
      ),
    },
    indexes: [
      {
        key: { tenantId: 1, email: 1 },
        name: "tenant_email_unique",
        unique: true,
      },
    ],
  },
  {
    name: "sessions",
    validator: {
      $jsonSchema: object(["tenantId", "userId", "expiresAt", "createdAt"], {
        _id: string({ pattern: "^[0-9a-f]{64}$" }),
        tenantId: objectId,
        userId: objectId,
        expiresAt: date,
        createdAt: date,
      }),
    },
    indexes: [
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
    ],
  },
  {
    name: "rateLimits",
    validator: {
      $jsonSchema: object(["count", "expiresAt"], {
        _id: string({ pattern: "^[A-Za-z0-9_-]{43}$" }),
        count: int(1, 2_147_483_647),
        expiresAt: date,
      }),
    },
    indexes: [
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
    ],
  },
  {
    name: "barbers",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "branchId",
          "slug",
          "name",
          "hours",
          "serviceIds",
          "active",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          branchId: objectId,
          userId: objectId,
          slug: string(),
          name: string(),
          specialty: localized,
          bio: localized,
          image: string(),
          images: { bsonType: "array", maxItems: 12, items: string() },
          hours,
          serviceIds: { bsonType: "array", items: objectId },
          lockVersion: { bsonType: ["int", "long"] },
          active: bool,
          ...timestamps,
        },
      ),
      $expr: opensBeforeCloses,
    },
    indexes: [
      {
        key: { tenantId: 1, slug: 1 },
        name: "tenant_slug_unique",
        unique: true,
      },
      { key: { tenantId: 1, branchId: 1 }, name: "tenant_branch" },
      {
        key: { tenantId: 1, userId: 1 },
        name: "tenant_user_unique",
        unique: true,
        partialFilterExpression: { userId: { $type: "objectId" } },
      },
    ],
  },
  {
    name: "timeOff",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "branchId",
          "startAt",
          "endAt",
          "kind",
          "createdBy",
          "createdAt",
        ],
        {
          tenantId: objectId,
          branchId: objectId,
          barberId: objectId,
          startAt: date,
          endAt: date,
          kind: oneOf(TIME_OFF_KINDS),
          reason: string(),
          createdBy: objectId,
          createdAt: date,
        },
      ),
      $expr: { $lt: ["$startAt", "$endAt"] },
    },
    indexes: [
      {
        key: { tenantId: 1, branchId: 1, endAt: 1 },
        name: "tenant_branch_end",
      },
    ],
  },
  {
    name: "services",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "slug",
          "name",
          "durationMin",
          "priceMinor",
          "position",
          "active",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          branchId: objectId,
          slug: string(),
          name: localized,
          description: localized,
          durationMin: int(5, 720),
          priceMinor: int(0, 10_000_000),
          image: string(),
          images: { bsonType: "array", maxItems: 12, items: string() },
          position: int(0, 10_000),
          active: bool,
          ...timestamps,
        },
      ),
    },
    indexes: [
      {
        key: { tenantId: 1, slug: 1 },
        name: "tenant_slug_unique",
        unique: true,
      },
    ],
  },
  {
    name: "packages",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "slug",
          "name",
          "priceMinor",
          "items",
          "position",
          "active",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          branchId: objectId,
          slug: string(),
          name: localized,
          description: localized,
          priceMinor: int(0, 10_000_000),
          items: {
            bsonType: "array",
            minItems: 2,
            maxItems: 10,
            items: object(["serviceId"], { serviceId: objectId }),
          },
          image: string(),
          images: { bsonType: "array", maxItems: 12, items: string() },
          position: int(0, 10_000),
          active: bool,
          ...timestamps,
        },
      ),
    },
    indexes: [
      {
        key: { tenantId: 1, slug: 1 },
        name: "tenant_slug_unique",
        unique: true,
      },
    ],
  },
  {
    name: "customers",
    validator: {
      $jsonSchema: object(["tenantId", "name", "createdAt", "updatedAt"], {
        tenantId: objectId,
        userId: objectId,
        name: string(),
        phone: string({ pattern: "^\\+?\\d{7,15}$" }),
        email: string(),
        ...timestamps,
      }),
    },
    indexes: [
      {
        key: { tenantId: 1, phone: 1 },
        name: "tenant_phone_unique",
        unique: true,
        partialFilterExpression: { phone: { $type: "string" } },
      },
      {
        key: { tenantId: 1, userId: 1 },
        name: "tenant_user_unique",
        unique: true,
        partialFilterExpression: { userId: { $type: "objectId" } },
      },
    ],
  },
  {
    name: "appointments",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "branchId",
          "barberId",
          "customerId",
          "status",
          "startAt",
          "endAt",
          "blockedUntil",
          "timeZone",
          "items",
          "currency",
          "subtotalMinor",
          "discountMinor",
          "totalMinor",
          "source",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          branchId: objectId,
          barberId: objectId,
          customerId: objectId,
          status: oneOf(APPOINTMENT_STATUSES),
          startAt: date,
          endAt: date,
          blockedUntil: date,
          timeZone: string(),
          items: {
            bsonType: "array",
            minItems: 1,
            items: object(["kind", "name", "durationMin", "priceMinor"], {
              kind: oneOf(["service", "package"]),
              name: localized,
              durationMin: int(5, 720),
              priceMinor: int(0, 10_000_000),
            }),
          },
          currency: string({ pattern: "^[A-Z]{3}$" }),
          subtotalMinor: int(0, 100_000_000),
          discountMinor: int(0, 100_000_000),
          totalMinor: int(0, 100_000_000),
          promotion: object(
            ["promotionId", "name", "type", "value", "amountMinor"],
            {
              promotionId: objectId,
              amountMinor: int(0, 100_000_000),
            },
          ),
          payment: object(["provider", "intentId", "status", "amountMinor"], {
            provider: oneOf(["stripe"]),
            intentId: string({ pattern: "^pi_" }),
            status: oneOf(["requires_payment", "paid", "refunded", "failed"]),
            amountMinor: int(1, 100_000_000),
            applicationFeeMinor: int(0, 100_000_000),
            paidAt: date,
          }),
          source: oneOf(["online", "staff"]),
          ...timestamps,
        },
      ),
      $expr: {
        $and: [
          { $lt: ["$startAt", "$endAt"] },
          { $lte: ["$endAt", "$blockedUntil"] },
          { $lte: ["$discountMinor", "$subtotalMinor"] },
          {
            $eq: [
              "$totalMinor",
              { $subtract: ["$subtotalMinor", "$discountMinor"] },
            ],
          },
        ],
      },
    },
    indexes: [
      {
        key: { barberId: 1, startAt: 1 },
        name: "barber_start_confirmed_unique",
        unique: true,
        partialFilterExpression: { status: "confirmed" },
      },
      {
        key: { tenantId: 1, branchId: 1, startAt: 1 },
        name: "tenant_branch_start",
      },
      {
        key: { tenantId: 1, customerId: 1, startAt: -1 },
        name: "tenant_customer_start",
      },
      {
        key: { "payment.intentId": 1 },
        name: "payment_intent",
        sparse: true,
      },
    ],
  },
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
          name: localized,
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
          maxRedemptions: int(1, 10_000_000),
          maxPerCustomer: int(1, 1000),
          redemptions: int(0, 10_000_000),
          active: bool,
          ...timestamps,
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
  {
    name: "notifications",
    validator: {
      $jsonSchema: object(
        ["tenantId", "userId", "type", "appointmentId", "summary", "createdAt"],
        {
          tenantId: objectId,
          userId: objectId,
          type: oneOf(NOTIFICATION_TYPES),
          appointmentId: objectId,
          summary: { bsonType: "object" },
          readAt: date,
          createdAt: date,
        },
      ),
    },
    indexes: [
      {
        key: { tenantId: 1, userId: 1, createdAt: -1 },
        name: "tenant_user_created",
      },
      {
        key: { createdAt: 1 },
        name: "createdAt_ttl",
        expireAfterSeconds: 90 * 24 * 60 * 60,
      },
    ],
  },
  {
    name: "images",
    validator: {
      $jsonSchema: object(
        ["tenantId", "contentType", "data", "size", "createdBy", "createdAt"],
        {
          _id: string({ pattern: "^[A-Za-z0-9_-]{22}$" }),
          tenantId: objectId,
          contentType: oneOf(["image/jpeg", "image/png", "image/webp"]),
          data: { bsonType: "binData" },
          size: int(1, 1024 * 1024),
          createdBy: objectId,
          createdAt: date,
        },
      ),
    },
    indexes: [{ key: { tenantId: 1, createdAt: -1 }, name: "tenant_created" }],
  },
  {
    name: "pushSubscriptions",
    validator: {
      $jsonSchema: object(
        ["tenantId", "userId", "endpoint", "keys", "createdAt", "updatedAt"],
        {
          tenantId: objectId,
          userId: objectId,
          endpoint: string({ pattern: "^https://" }),
          keys: object(["p256dh", "auth"], {
            p256dh: string(),
            auth: string(),
          }),
          ...timestamps,
        },
      ),
    },
    indexes: [
      { key: { endpoint: 1 }, name: "endpoint_unique", unique: true },
      { key: { tenantId: 1, userId: 1 }, name: "tenant_user" },
    ],
  },
  {
    name: "referrals",
    validator: {
      $jsonSchema: object(
        [
          "referrerTenantId",
          "refereeTenantId",
          "code",
          "discountPercent",
          "status",
          "checkoutSessionId",
          "currency",
          "subtotalMinor",
          "rewardMinor",
          "createdAt",
        ],
        {
          referrerTenantId: objectId,
          refereeTenantId: objectId,
          code: string({ pattern: REFERRAL_CODE }),
          discountPercent: int(1, 100),
          status: oneOf(REFERRAL_STATUSES),
          checkoutSessionId: string({ pattern: "^cs_\\w+$" }),
          currency: string({ pattern: "^[a-z]{3}$" }),
          subtotalMinor: int(0, 100_000_000),
          rewardMinor: int(0, 100_000_000),
          stripeBalanceTransactionId: string(),
          createdAt: date,
          rewardedAt: date,
        },
      ),
      $expr: { $ne: ["$referrerTenantId", "$refereeTenantId"] },
    },
    indexes: [
      { key: { refereeTenantId: 1 }, name: "referee_unique", unique: true },
      { key: { referrerTenantId: 1 }, name: "referrer" },
    ],
  },
];
