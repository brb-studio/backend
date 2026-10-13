import type { Binary, ObjectId } from "mongodb";
import { billingSpecs } from "./billing";
import { db } from "./client";
import {
  APPOINTMENT_PAYMENT_STATUSES,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  type PaymentKind,
  type PaymentMethod,
  paymentSpecs,
} from "./payments";
import type { CollectionSpec } from "./setup";
import {
  bool,
  date,
  int,
  object,
  objectId,
  oneOf,
  REFERRAL_CODE,
  string,
} from "./validators";

export * from "./billing";
export * from "./payments";

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
/** `onboarding`: the owner hasn't finished Stripe's form; `pending`: Stripe is reviewing; `restricted`: Stripe needs more or refused. */
export const CONNECT_STATUSES = [
  "onboarding",
  "pending",
  "active",
  "restricted",
] as const;

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
  /** Legacy Stripe Connect state. Kept so old documents stay valid; nothing reads or writes it anymore. */
  stripe?: {
    accountId: string;
    detailsSubmitted: boolean;
    chargesEnabled: boolean;
    onboardedAt?: Date;
  };
  /** Where customers send SPEI transfers: the barbershop's own account. Both are required to enable transfers. */
  bankAccountKey?: string;
  bankAccountHolder?: string;
  bankTransferEnabled?: boolean;
  /**
   * The barbershop's Stripe connected account (Accounts v2, recipient configuration): card and bank
   * transfer payments are charged by the platform and transferred here. Only Stripe's webhooks (or a
   * fresh read of the account from Stripe) change `status` and `requirementsDue`.
   */
  stripeConnect?: {
    accountId: string;
    /** `active` once Stripe can transfer to it; only then are online payments offered. */
    status: (typeof CONNECT_STATUSES)[number];
    /** What Stripe still needs from the owner (machine-readable descriptions). */
    requirementsDue: string[];
    /**
     * Fees the platform lost refunding the shop's customers (the shop cancelled or refunded), still
     * owed by the shop: added to the fee of its next online payments until paid off.
     */
    feeDebtMinor?: number;
    /** The currency of `feeDebtMinor`: only payments in that currency collect it. */
    feeDebtCurrency?: string;
    createdAt: Date;
    updatedAt: Date;
  };
  /** Online payment rules: when `enabled`, booking online requires paying at least `percentBps` of the total. */
  deposit?: { enabled: boolean; percentBps: number };
  /** Reminders to customers 24 h and 2 h before their appointment; on unless `enabled` is false. */
  reminders?: { enabled: boolean };
  /** Optional module: products customers set aside and staff hand over. Off unless `enabled`. */
  products?: { enabled: boolean };
  billing?: {
    /** Legacy Stripe subscription ids and cancellation date; nothing reads or writes them anymore. */
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    cancelAt?: Date;
    firstPaidAt?: Date;
    /** Referral rewards waiting to discount the next subscription payments. */
    creditMinor?: number;
  };
  referralCode?: string;
  createdAt: Date;
  updatedAt: Date;
};

export const REFERRAL_STATUSES = ["pending", "rewarded", "skipped"] as const;

export type ReferralDoc = {
  _id: ObjectId;
  referrerTenantId: ObjectId;
  refereeTenantId: ObjectId;
  code: string;
  discountPercent: number;
  status: (typeof REFERRAL_STATUSES)[number];
  /** The subscription payment that earned the reward. */
  paymentId?: ObjectId;
  /** Legacy, from the Stripe days. */
  checkoutSessionId?: string;
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

/**
 * An account of one barbershop (a person with N barbershops has N independent `users`, one per
 * tenant; nothing links them because emails are not verified). Staff and customers share the
 * collection; a customer who booked without signing up is a `guest` record: no login, only the
 * contact data the shop needs. Appointments point at it through `customerId`.
 */
export type UserDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  /** The login; guests have none. */
  email?: string;
  passwordHash?: string;
  name: string;
  phone?: string;
  /** Guests only: the email they left when booking. Never a login, so it can't squat a real signup. */
  contactEmail?: string;
  guest?: true;
  /** When the owner of the email proved control of it (a verification link or a password reset). */
  emailVerifiedAt?: Date;
  /** The Stripe Customer used for bank transfers (on the platform account); Stripe gives it its own CLABE. */
  stripeCustomerId?: string;
  /** Set by the customers → users migration: the `customers` document this record replaces. */
  legacyCustomerId?: ObjectId;
  role: Role;
  branchId?: ObjectId;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** A single-use emailed link; `_id` is the SHA-256 of the token, which is never stored. */
export type AuthTokenDoc = {
  _id: string;
  tenantId: ObjectId;
  userId: ObjectId;
  kind: "verify_email" | "reset_password";
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
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
  images?: string[];
  hours: Hours[];
  serviceIds: ObjectId[];
  /** Commission in basis points (1000 = 10%) of each completed appointment's total. Unset = not configured. */
  commissionBps?: number;
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

export type RateLimitDoc = { _id: string; count: number; expiresAt: Date };

export const tenants = db.collection<TenantDoc>("tenants");
export const referrals = db.collection<ReferralDoc>("referrals");
export const branches = db.collection<BranchDoc>("branches");
export const users = db.collection<UserDoc>("users");
export const sessions = db.collection<SessionDoc>("sessions");
export const authTokens = db.collection<AuthTokenDoc>("authTokens");
export const rateLimits = db.collection<RateLimitDoc>("rateLimits");
export const barbers = db.collection<BarberDoc>("barbers");
export const timeOff = db.collection<TimeOffDoc>("timeOff");
export const services = db.collection<ServiceDoc>("services");
export const packages = db.collection<PackageDoc>("packages");

/** `pending_payment`: booked online and waiting for the payment; it holds the slot until `paymentDeadline`. */
export const APPOINTMENT_STATUSES = [
  "confirmed",
  "pending_payment",
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

/** `requires_payment` and `failed` only exist on legacy Stripe Connect payments (before 2026). */
export const APPOINTMENT_SUMMARY_STATUSES = [
  ...APPOINTMENT_PAYMENT_STATUSES,
  "requires_payment",
  "failed",
] as const;
export type AppointmentPaymentStatus =
  (typeof APPOINTMENT_SUMMARY_STATUSES)[number];

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
  /** Online bookings waiting to be paid: past this instant the slot is free again and the booking is cancelled. */
  paymentDeadline?: Date;
  /**
   * Summary of the latest payment; the `payments` document is the source of truth. `spei` = manual
   * transfer to the barbershop's own CLABE. `stripe` with a `paymentId` = card or bank transfer through
   * Stripe; without one, a legacy Stripe Connect payment.
   */
  payment?: {
    provider: "stripe" | "spei";
    intentId?: string;
    paymentId?: ObjectId;
    method?: PaymentMethod;
    kind?: PaymentKind;
    status: AppointmentPaymentStatus;
    /** What was asked: the deposit or the whole total. */
    amountMinor: number;
    refundedMinor?: number;
    applicationFeeMinor?: number;
    /** Part of the fee that paid the shop's fee debt, so the customer's refund never covers it. */
    debtMinor?: number;
    cardBrand?: string;
    cardLast4?: string;
    paidAt?: Date;
  };
  /** Frozen when the appointment is completed (or its commission is paid) so later rate changes can't rewrite history. */
  commission?: { bps: number; amountMinor: number };
  /** The payout that settled this appointment's commission; set together with the payout, never alone. */
  payoutId?: ObjectId;
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

export const appointments = db.collection<AppointmentDoc>("appointments");
export const promotions = db.collection<PromotionDoc>("promotions");

/**
 * `payment.disputed` and `payment.transfer_requested` go to owners and admins: a customer opened a chargeback on an online
 * payment, or asked for the bank details of a manual SPEI transfer they will have to confirm.
 * `customer.*` go to the customer's own account when someone else changes their appointment or payment.
 */
export const NOTIFICATION_TYPES = [
  "appointment.booked",
  "appointment.cancelled",
  "appointment.rescheduled",
  "payment.disputed",
  "payment.transfer_requested",
  "customer.booked",
  "customer.cancelled",
  "customer.rescheduled",
  "customer.paid",
  "customer.payment_rejected",
  "customer.reminder",
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
    barberName?: string;
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

export type ProductDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  /** Sold at one branch only; without it, at every branch. */
  branchId?: ObjectId;
  slug: string;
  name: Localized;
  description?: Localized;
  priceMinor: number;
  image?: string;
  images?: string[];
  category?: string;
  /** Units left. Absent = not counted (never runs out). */
  stock?: number;
  position: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};
export const products = db.collection<ProductDoc>("products");

export const PRODUCT_ORDER_STATUSES = [
  "reserved",
  "delivered",
  "cancelled",
  "expired",
] as const;
export const PRODUCT_PAYMENT_METHODS = ["cash", "spei"] as const;

/** Products a customer set aside at a branch, handed over (and paid, in cash or by transfer) by staff. */
export type ProductOrderDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  branchId: ObjectId;
  customerId: ObjectId;
  status: (typeof PRODUCT_ORDER_STATUSES)[number];
  items: {
    productId: ObjectId;
    name: Localized;
    priceMinor: number;
    quantity: number;
  }[];
  currency: string;
  totalMinor: number;
  /** Past this instant an unclaimed reservation is released. */
  expiresAt: Date;
  payment?: {
    method: (typeof PRODUCT_PAYMENT_METHODS)[number];
    receivedBy: ObjectId;
    at: Date;
  };
  closedAt?: Date;
  closedBy?: ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const productOrders = db.collection<ProductOrderDoc>("productOrders");

export const WAITLIST_STATUSES = ["waiting", "notified"] as const;

/** A customer asking to be told when a time that fits frees up on a day. Gone when the day is over. */
export type WaitlistDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  customerId: ObjectId;
  branchId: ObjectId;
  /** What they want, frozen as the visitor saw it. */
  item: { kind: "service" | "package"; slug: string; name: Localized };
  barberId?: ObjectId;
  /** Local date in the branch's zone, `YYYY-MM-DD`. */
  date: string;
  /** Local `HH:MM` window the visit must start in. */
  from?: string;
  to?: string;
  status: (typeof WAITLIST_STATUSES)[number];
  notifiedAt?: Date;
  /** End of `date` in the branch's zone: MongoDB's TTL index deletes the entry then. */
  expiresAt: Date;
  createdAt: Date;
};

export const waitlist = db.collection<WaitlistDoc>("waitlist");

/** Platform staff work across every barbershop; they live outside any tenant. */
export type PlatformStaffDoc = {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type PlatformSessionDoc = {
  _id: string;
  staffId: ObjectId;
  expiresAt: Date;
  createdAt: Date;
};

/** A commission payment to a barber, settling whole appointments (each one in at most one payout). */
export type PayoutDoc = {
  _id: ObjectId;
  tenantId: ObjectId;
  barberId: ObjectId;
  currency: string;
  amountMinor: number;
  appointmentIds: ObjectId[];
  reference?: string;
  paidAt: Date;
  createdBy: ObjectId;
  createdAt: Date;
};

export const platformStaff = db.collection<PlatformStaffDoc>("platformStaff");
export const platformSessions =
  db.collection<PlatformSessionDoc>("platformSessions");
export const payouts = db.collection<PayoutDoc>("payouts");

const HHMM = "^([01]\\d|2[0-3]):[0-5]\\d$";
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
          bankAccountKey: string({ pattern: "^\\d{18}$" }),
          bankAccountHolder: string({ minLength: 1, maxLength: 120 }),
          bankTransferEnabled: bool,
          stripeConnect: object(
            [
              "accountId",
              "status",
              "requirementsDue",
              "createdAt",
              "updatedAt",
            ],
            {
              accountId: string({ pattern: "^acct_" }),
              status: oneOf(CONNECT_STATUSES),
              requirementsDue: {
                bsonType: "array",
                maxItems: 100,
                items: string({ maxLength: 200 }),
              },
              feeDebtMinor: int(0, 100_000_000),
              feeDebtCurrency: string({ pattern: "^[A-Z]{3}$" }),
              createdAt: date,
              updatedAt: date,
            },
          ),
          deposit: object(["enabled", "percentBps"], {
            enabled: bool,
            percentBps: int(100, 10_000),
          }),
          reminders: object(["enabled"], { enabled: bool }),
          products: object(["enabled"], { enabled: bool }),
          billing: {
            bsonType: "object",
            properties: {
              stripeCustomerId: string({ pattern: "^cus_\\w+$" }),
              stripeSubscriptionId: string({ pattern: "^sub_\\w+$" }),
              firstPaidAt: date,
              cancelAt: date,
              creditMinor: int(0, 100_000_000),
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
        key: { "stripeConnect.accountId": 1 },
        name: "stripe_connect_unique",
        unique: true,
        partialFilterExpression: {
          "stripeConnect.accountId": { $type: "string" },
        },
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
      $jsonSchema: {
        ...object(
          ["tenantId", "name", "role", "active", "createdAt", "updatedAt"],
          {
            tenantId: objectId,
            email: string({ pattern: "^[^A-Z\\s]+@[^A-Z\\s]+$" }),
            passwordHash: string({ pattern: "^\\$argon2id\\$" }),
            name: string(),
            phone: string(),
            contactEmail: string(),
            guest: { bsonType: "bool", enum: [true] },
            emailVerifiedAt: date,
            stripeCustomerId: string({ pattern: "^cus_" }),
            legacyCustomerId: objectId,
            role: oneOf(ROLES),
            branchId: objectId,
            active: bool,
            ...timestamps,
          },
        ),
        // An account can sign in; a guest is a customer contact record and can't.
        anyOf: [
          { required: ["email", "passwordHash"] },
          { required: ["guest"], properties: { role: oneOf(["customer"]) } },
        ],
      },
    },
    dropIndexes: ["tenant_email_unique"],
    indexes: [
      {
        key: { tenantId: 1, email: 1 },
        name: "tenant_login_unique",
        unique: true,
        partialFilterExpression: { email: { $type: "string" } },
      },
      // One guest record per phone and barbershop: repeat bookings reuse it.
      {
        key: { tenantId: 1, phone: 1 },
        name: "tenant_guest_phone_unique",
        unique: true,
        partialFilterExpression: { guest: true, phone: { $type: "string" } },
      },
      {
        key: { tenantId: 1, legacyCustomerId: 1 },
        name: "tenant_legacy_customer_unique",
        unique: true,
        partialFilterExpression: { legacyCustomerId: { $type: "objectId" } },
      },
      // The staff list (role ≠ customer) must not scan every customer account of the barbershop.
      { key: { tenantId: 1, role: 1 }, name: "tenant_role" },
    ],
  },
  {
    name: "authTokens",
    validator: {
      $jsonSchema: object(
        ["tenantId", "userId", "kind", "expiresAt", "createdAt"],
        {
          _id: string({ pattern: "^[0-9a-f]{64}$" }),
          tenantId: objectId,
          userId: objectId,
          kind: oneOf(["verify_email", "reset_password"]),
          expiresAt: date,
          usedAt: date,
          createdAt: date,
        },
      ),
    },
    indexes: [
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
      { key: { tenantId: 1, userId: 1, kind: 1 }, name: "tenant_user_kind" },
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
          commissionBps: int(0, 10_000),
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
          paymentDeadline: date,
          payment: object(["provider", "status", "amountMinor"], {
            provider: oneOf(["stripe", "spei"]),
            intentId: string({ pattern: "^pi_" }),
            paymentId: objectId,
            method: oneOf(PAYMENT_METHODS),
            kind: oneOf(PAYMENT_KINDS),
            status: oneOf(APPOINTMENT_SUMMARY_STATUSES),
            amountMinor: int(1, 100_000_000),
            refundedMinor: int(0, 100_000_000),
            applicationFeeMinor: int(0, 100_000_000),
            debtMinor: int(0, 100_000_000),
            cardBrand: string({ maxLength: 40 }),
            cardLast4: string({ pattern: "^\\d{4}$" }),
            paidAt: date,
          }),
          commission: object(["bps", "amountMinor"], {
            bps: int(0, 10_000),
            amountMinor: int(0, 100_000_000),
          }),
          payoutId: objectId,
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
      // A barber can't have two live bookings at the same start, including one held while it is being paid.
      {
        key: { barberId: 1, startAt: 1 },
        name: "barber_start_live_unique",
        unique: true,
        partialFilterExpression: {
          status: { $in: ["confirmed", "pending_payment"] },
        },
      },
      {
        key: { tenantId: 1, branchId: 1, startAt: 1 },
        name: "tenant_branch_start",
      },
      {
        key: { tenantId: 1, customerId: 1, startAt: -1 },
        name: "tenant_customer_start",
      },
      // The reminder sweep reads one barbershop's next 24 hours across every branch.
      { key: { tenantId: 1, startAt: 1 }, name: "tenant_start" },
      {
        key: { "payment.intentId": 1 },
        name: "payment_intent",
        sparse: true,
      },
      // Barber agenda and earnings read one barber over a range of days, across every status.
      { key: { barberId: 1, startAt: 1 }, name: "barber_start" },
      // Platform reports across barbershops (no tenant in the filter).
      { key: { startAt: 1 }, name: "start" },
      // The sweep that frees slots held by unpaid online bookings.
      {
        key: { tenantId: 1, paymentDeadline: 1 },
        name: "tenant_hold_deadline",
        partialFilterExpression: { status: "pending_payment" },
      },
    ],
    /** Replaced by `barber_start_live_unique`, which also guards slots held while being paid. */
    dropIndexes: ["barber_start_confirmed_unique"],
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
    name: "products",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "slug",
          "name",
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
          priceMinor: int(0, 10_000_000),
          image: string(),
          images: { bsonType: "array", maxItems: 12, items: string() },
          category: string({ maxLength: 40 }),
          stock: int(0, 1_000_000),
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
    name: "productOrders",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "branchId",
          "customerId",
          "status",
          "items",
          "currency",
          "totalMinor",
          "expiresAt",
          "createdAt",
          "updatedAt",
        ],
        {
          tenantId: objectId,
          branchId: objectId,
          customerId: objectId,
          status: oneOf(PRODUCT_ORDER_STATUSES),
          items: {
            bsonType: "array",
            minItems: 1,
            maxItems: 10,
            items: object(["productId", "name", "priceMinor", "quantity"], {
              productId: objectId,
              name: localized,
              priceMinor: int(0, 10_000_000),
              quantity: int(1, 99),
            }),
          },
          currency: string({ pattern: "^[A-Z]{3}$" }),
          totalMinor: int(0, 100_000_000),
          expiresAt: date,
          payment: object(["method", "receivedBy", "at"], {
            method: oneOf(PRODUCT_PAYMENT_METHODS),
            receivedBy: objectId,
            at: date,
          }),
          closedAt: date,
          closedBy: objectId,
          ...timestamps,
        },
      ),
    },
    indexes: [
      {
        key: { tenantId: 1, customerId: 1, createdAt: -1 },
        name: "tenant_customer_created",
      },
      // Staff read what is waiting at a branch; the sweep reads what has expired.
      {
        key: { tenantId: 1, status: 1, expiresAt: 1 },
        name: "tenant_status_expires",
      },
    ],
  },
  {
    name: "waitlist",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "customerId",
          "branchId",
          "item",
          "date",
          "status",
          "expiresAt",
          "createdAt",
        ],
        {
          tenantId: objectId,
          customerId: objectId,
          branchId: objectId,
          item: object(["kind", "slug", "name"], {
            kind: oneOf(["service", "package"]),
            slug: string({ maxLength: 64 }),
            name: localized,
          }),
          barberId: objectId,
          date: string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
          from: string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
          to: string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
          status: oneOf(WAITLIST_STATUSES),
          notifiedAt: date,
          expiresAt: date,
          createdAt: date,
        },
      ),
    },
    indexes: [
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
      // The notifier walks the waiting entries oldest first; a customer reads their own.
      {
        key: { tenantId: 1, status: 1, createdAt: 1 },
        name: "tenant_status_created",
      },
      { key: { tenantId: 1, customerId: 1 }, name: "tenant_customer" },
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
          paymentId: objectId,
          checkoutSessionId: string({ pattern: "^cs_\\w+$" }),
          currency: string({ pattern: "^[a-zA-Z]{3}$" }),
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
  {
    name: "platformStaff",
    validator: {
      $jsonSchema: object(
        ["email", "name", "passwordHash", "active", "createdAt", "updatedAt"],
        {
          email: string(),
          name: string(),
          passwordHash: string(),
          active: bool,
          ...timestamps,
        },
      ),
    },
    indexes: [{ key: { email: 1 }, name: "email_unique", unique: true }],
  },
  {
    name: "platformSessions",
    validator: {
      $jsonSchema: object(["staffId", "expiresAt", "createdAt"], {
        staffId: objectId,
        expiresAt: date,
        createdAt: date,
      }),
    },
    indexes: [
      { key: { expiresAt: 1 }, name: "expiresAt_ttl", expireAfterSeconds: 0 },
    ],
  },
  {
    name: "payouts",
    validator: {
      $jsonSchema: object(
        [
          "tenantId",
          "barberId",
          "currency",
          "amountMinor",
          "appointmentIds",
          "paidAt",
          "createdBy",
          "createdAt",
        ],
        {
          tenantId: objectId,
          barberId: objectId,
          currency: string({ pattern: "^[A-Z]{3}$" }),
          amountMinor: int(0, 1_000_000_000),
          appointmentIds: { bsonType: "array", minItems: 1, items: objectId },
          reference: string({ maxLength: 120 }),
          paidAt: date,
          createdBy: objectId,
          createdAt: date,
        },
      ),
    },
    indexes: [
      // An appointment's commission is settled by at most one payout: the database refuses a second.
      {
        key: { appointmentIds: 1 },
        name: "appointment_once",
        unique: true,
      },
    ],
  },
  ...billingSpecs,
  ...paymentSpecs,
];
