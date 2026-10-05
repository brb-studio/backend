import { ObjectId } from "mongodb";
import Stripe from "stripe";
import type * as z from "zod";
import { config } from "../../config";
import { hit } from "../../db/rate-limit";
import {
  forTenant,
  platform,
  type ReferralDoc,
  type TenantDoc,
} from "../../db/scoped";
import { AppError, isDuplicate } from "../../shared/http";
import { requireStripe } from "../payments/stripe";
import { tenantQuery } from "../tenancy/service";
import { PLAN_LIMITS } from "../tenancy/subscription";
import {
  hasLiveSubscription,
  newReferralCode,
  REFERRAL,
  rewardFor,
  SUBSCRIPTION_PLAN,
  toStatus,
} from "./rules";
import type { checkoutInput } from "./schemas";

/**
 * Subscriptions: the barbershop pays us, on the platform's own Stripe account (Stripe Billing).
 * Appointment payments (features/payments) are the opposite direction, on each barbershop's Connect account.
 */

const HOUR_MS = 60 * 60 * 1000;
const COUPON_ID = `brb-referral-${REFERRAL.friendPercent}`;

const subscriptionPrice = () => config.STRIPE_SUBSCRIPTION_PRICE;

function billing() {
  const price = subscriptionPrice();
  if (!price) {
    throw new AppError(
      503,
      "BILLING_DISABLED",
      "Subscriptions are not configured on this server",
    );
  }
  return { stripe: requireStripe(), price };
}

/** Stripe failures become one 502: the owner can retry, Stripe retries webhooks on its own. */
async function call<T>(work: (stripe: Stripe) => Promise<T>) {
  try {
    return await work(billing().stripe);
  } catch (err) {
    if (!(err instanceof Stripe.errors.StripeError)) throw err;
    console.error(
      JSON.stringify({
        level: "error",
        event: "stripe_billing_error",
        type: err.type,
        code: err.code,
        message: err.message,
      }),
    );
    throw new AppError(502, "PAYMENT_ERROR", "Payment provider error");
  }
}

const ownerOf = (tenantId: ObjectId) =>
  forTenant(tenantId).users.findOne({ role: "owner" });

// ---------- summary and referral code ----------

/** Only a barbershop that has paid at least once gets a code to share. Created on first look. */
async function ensureReferralCode(tenant: TenantDoc) {
  if (tenant.referralCode) return tenant.referralCode;
  if (!tenant.billing?.firstPaidAt) return undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await platform.tenants.findOneAndUpdate(
        { _id: tenant._id, referralCode: { $exists: false } },
        { $set: { referralCode: newReferralCode() } },
        { returnDocument: "after" },
      );
      if (updated) return updated.referralCode;
      return (await platform.tenants.findOne({ _id: tenant._id }))
        ?.referralCode;
    } catch (err) {
      if (!isDuplicate(err)) throw err;
    }
  }
  throw new AppError(500, "INTERNAL", "Could not create a referral code");
}

let priceInfo:
  | Promise<{ amountMinor: number; currency: string; interval: string }>
  | undefined;

/** What the subscription costs, read once from Stripe so the price is set in one place only. */
function subscriptionPriceInfo() {
  priceInfo ??= call(async (stripe) => {
    const price = await stripe.prices.retrieve(billing().price);
    return {
      amountMinor: price.unit_amount ?? 0,
      currency: price.currency.toUpperCase(),
      interval: price.recurring?.interval ?? "month",
    };
  }).catch((err) => {
    priceInfo = undefined;
    throw err;
  });
  return priceInfo;
}

export async function billingSummary(tenant: TenantDoc) {
  const code = await ensureReferralCode(tenant);
  const price = subscriptionPrice() ? await subscriptionPriceInfo() : null;
  const [stats] = await platform.referrals
    .aggregate<{ referred: number; rewarded: number; earnedMinor: number }>([
      { $match: { referrerTenantId: tenant._id } },
      {
        $group: {
          _id: null,
          referred: { $sum: 1 },
          rewarded: {
            $sum: { $cond: [{ $eq: ["$status", "rewarded"] }, 1, 0] },
          },
          earnedMinor: {
            $sum: {
              $cond: [{ $eq: ["$status", "rewarded"] }, "$rewardMinor", 0],
            },
          },
        },
      },
    ])
    .toArray();
  const customerId = tenant.billing?.stripeCustomerId;
  const customer =
    customerId &&
    (await call((stripe) => stripe.customers.retrieve(customerId)));
  const referredBy = await platform.referrals.findOne({
    refereeTenantId: tenant._id,
  });
  return {
    /** `null` when subscriptions aren't configured on this server. */
    price,
    plan: tenant.subscription.plan,
    status: tenant.subscription.status,
    currentPeriodEnd: tenant.subscription.currentPeriodEnd,
    cancelAt: tenant.billing?.cancelAt,
    subscribed: hasLiveSubscription(tenant),
    // Stripe keeps credit as a negative balance and spends it on the next invoices by itself.
    creditMinor:
      customer && !customer.deleted ? Math.max(0, -customer.balance) : 0,
    referral: {
      code: code ?? null,
      friendPercent: REFERRAL.friendPercent,
      rewardPercent: REFERRAL.rewardPercent,
      referred: stats?.referred ?? 0,
      rewarded: stats?.rewarded ?? 0,
      earnedMinor: stats?.earnedMinor ?? 0,
    },
    ...(referredBy && {
      referredBy: { discountPercent: referredBy.discountPercent },
    }),
  };
}

/**
 * A code works once per barbershop, on its first paid month, and never for itself (same tenant or same
 * owner email). Brute force is pointless (40-bit codes) but still capped.
 */
export async function checkReferral(tenant: TenantDoc, code: string) {
  if (!(await hit(`referral:${tenant._id}`, 20, HOUR_MS))) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many attempts, try again later",
    );
  }
  const referrer = await platform.tenants.findOne({ referralCode: code });
  if (!referrer) {
    throw new AppError(404, "REFERRAL_NOT_FOUND", "Unknown referral code");
  }
  const [mine, theirs] = await Promise.all([
    ownerOf(tenant._id),
    ownerOf(referrer._id),
  ]);
  if (
    referrer._id.equals(tenant._id) ||
    (mine && theirs && mine.email === theirs.email)
  ) {
    throw new AppError(409, "REFERRAL_SELF", "You can't use your own code");
  }
  const referred = await platform.referrals.countDocuments({
    refereeTenantId: tenant._id,
  });
  if (tenant.billing?.firstPaidAt || referred > 0) {
    throw new AppError(
      409,
      "REFERRAL_NOT_FIRST",
      "Referral codes only apply to the first paid month",
    );
  }
  return { referrer, code, discountPercent: REFERRAL.friendPercent };
}

// ---------- checkout and portal ----------

/** The return URL must point at this tenant's own site, or checkout becomes an open redirect. */
function assertOwnUrl(tenant: TenantDoc, raw: string) {
  const url = new URL(raw);
  const query = tenantQuery(url.host);
  const own =
    query &&
    (("slug" in query && query.slug === tenant.slug) ||
      ("customDomain" in query && query.customDomain === tenant.customDomain));
  if (!own || (config.NODE_ENV === "production" && url.protocol !== "https:")) {
    throw new AppError(422, "VALIDATION", "Invalid request", [
      { path: "returnUrl", message: "must be this barbershop's site" },
    ]);
  }
  return url;
}

const withParam = (url: URL, key: string, value: string) => {
  const copy = new URL(url);
  copy.searchParams.set(key, value);
  return copy.toString();
};

async function ensureCustomer(tenant: TenantDoc) {
  if (tenant.billing?.stripeCustomerId) return tenant.billing.stripeCustomerId;
  const owner = await ownerOf(tenant._id);
  const customer = await call((stripe) =>
    stripe.customers.create(
      {
        name: tenant.name,
        ...(owner && { email: owner.email }),
        metadata: { tenantId: tenant._id.toHexString(), slug: tenant.slug },
      },
      { idempotencyKey: `customer-${tenant._id}` },
    ),
  );
  await platform.tenants.updateOne(
    { _id: tenant._id, "billing.stripeCustomerId": { $exists: false } },
    { $set: { "billing.stripeCustomerId": customer.id } },
  );
  const saved = await platform.tenants.findOne({ _id: tenant._id });
  return saved?.billing?.stripeCustomerId ?? customer.id;
}

let couponReady: Promise<void> | undefined;

/** The friend's discount: one Stripe coupon, created once, applied to one invoice only. */
function ensureCoupon() {
  couponReady ??= call(async (stripe) => {
    try {
      await stripe.coupons.create({
        id: COUPON_ID,
        percent_off: REFERRAL.friendPercent,
        duration: "once",
        name: `Referido ${REFERRAL.friendPercent}%`,
      });
    } catch (err) {
      if (
        !(err instanceof Stripe.errors.StripeError) ||
        err.code !== "resource_already_exists"
      ) {
        throw err;
      }
    }
  }).catch((err) => {
    couponReady = undefined;
    throw err;
  });
  return couponReady;
}

export async function startCheckout(
  tenant: TenantDoc,
  input: z.output<typeof checkoutInput>,
) {
  const { price } = billing();
  const returnUrl = assertOwnUrl(tenant, input.returnUrl);
  if (tenant.subscription.plan === "lifetime") {
    throw new AppError(409, "LIFETIME_PLAN", "This barbershop never pays");
  }
  if (hasLiveSubscription(tenant)) {
    throw new AppError(
      409,
      "ALREADY_SUBSCRIBED",
      "Already subscribed; manage it from the billing portal",
    );
  }
  const referral =
    input.referralCode !== undefined
      ? await checkReferral(tenant, input.referralCode)
      : undefined;
  if (!(await hit(`checkout:${tenant._id}`, 10, HOUR_MS))) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many attempts, try again later",
    );
  }
  const customer = await ensureCustomer(tenant);
  if (referral) await ensureCoupon();
  const tenantId = tenant._id.toHexString();
  const session = await call((stripe) =>
    stripe.checkout.sessions.create({
      mode: "subscription",
      customer,
      client_reference_id: tenantId,
      line_items: [{ price, quantity: 1 }],
      locale: tenant.defaultLocale,
      success_url: withParam(returnUrl, "checkout", "success"),
      cancel_url: withParam(returnUrl, "checkout", "cancel"),
      metadata: {
        tenantId,
        ...(referral && {
          referrerTenantId: referral.referrer._id.toHexString(),
          referralCode: referral.code,
        }),
      },
      subscription_data: { metadata: { tenantId } },
      ...(referral && { discounts: [{ coupon: COUPON_ID }] }),
    }),
  );
  if (!session.url) {
    throw new AppError(502, "PAYMENT_ERROR", "Stripe gave no checkout URL");
  }
  return { url: session.url };
}

export async function openPortal(tenant: TenantDoc, rawReturnUrl: string) {
  const returnUrl = assertOwnUrl(tenant, rawReturnUrl);
  const customer = tenant.billing?.stripeCustomerId;
  if (!customer) {
    throw new AppError(409, "NO_BILLING_ACCOUNT", "Nothing paid yet");
  }
  const session = await call((stripe) =>
    stripe.billingPortal.sessions.create({
      customer,
      return_url: returnUrl.toString(),
    }),
  );
  return { url: session.url };
}

// ---------- webhooks ----------

const TERMINAL = new Set(["canceled", "incomplete_expired"]);

const idOf = (hex: string | null | undefined) =>
  hex && /^[a-f\d]{24}$/.test(hex) ? new ObjectId(hex) : undefined;

const idOfRef = (ref: string | { id: string } | null) =>
  typeof ref === "string" ? ref : ref?.id;

/**
 * Reads the subscription back from Stripe instead of trusting the event body: events can arrive out of
 * order, the API always has the latest state.
 */
/** Webhook recovery (or admin resync): pull one subscription from Stripe. */
export async function syncSubscription(subscriptionId: string) {
  const { price } = billing();
  const sub = await call((stripe) =>
    stripe.subscriptions.retrieve(subscriptionId),
  );
  const customerId = idOfRef(sub.customer);
  const metadataId = idOf(sub.metadata?.tenantId);
  const tenant =
    (customerId &&
      (await platform.tenants.findOne({
        "billing.stripeCustomerId": customerId,
      }))) ||
    (metadataId && (await platform.tenants.findOne({ _id: metadataId })));
  if (!tenant || tenant.subscription.plan === "lifetime") return;
  const current = tenant.billing?.stripeSubscriptionId;
  // An old, ended subscription must not overwrite the one that replaced it.
  if (current && current !== sub.id && TERMINAL.has(sub.status)) return;
  const status = toStatus(sub.status);
  if (!status) return;
  const item = sub.items.data[0];
  const plan =
    item?.price.id === price ? SUBSCRIPTION_PLAN : tenant.subscription.plan;
  // Cancelling from the portal keeps the subscription active until the paid period ends; Stripe marks
  // it with `cancel_at` (or `cancel_at_period_end` on older API versions). Reactivating clears both.
  const cancelAtSec =
    status === "canceled"
      ? null
      : (sub.cancel_at ??
        (sub.cancel_at_period_end ? item?.current_period_end : null));
  const now = new Date();
  await platform.tenants.updateOne(
    { _id: tenant._id },
    {
      ...(!cancelAtSec && { $unset: { "billing.cancelAt": "" } }),
      $set: {
        ...(cancelAtSec && {
          "billing.cancelAt": new Date(cancelAtSec * 1000),
        }),
        "subscription.plan": plan,
        "subscription.status": status,
        "subscription.limits": PLAN_LIMITS[plan],
        ...(item && {
          "subscription.currentPeriodEnd": new Date(
            item.current_period_end * 1000,
          ),
        }),
        ...(customerId && { "billing.stripeCustomerId": customerId }),
        "billing.stripeSubscriptionId": sub.id,
        updatedAt: now,
      },
      ...(status === "active" && { $min: { "billing.firstPaidAt": now } }),
    },
  );
}

/**
 * Credits the referrer once the friend's first month is paid. Retried webhooks are safe: one referral per
 * referee (unique index), and the Stripe credit carries an idempotency key.
 */
async function rewardReferral(
  session: Stripe.Checkout.Session,
  refereeTenantId: ObjectId,
) {
  const referrerTenantId = idOf(session.metadata?.referrerTenantId);
  const code = session.metadata?.referralCode;
  if (!referrerTenantId || !code || !session.currency) return;
  const subtotal = session.amount_subtotal ?? 0;
  const referral: ReferralDoc = {
    _id: new ObjectId(),
    referrerTenantId,
    refereeTenantId,
    code,
    discountPercent: REFERRAL.friendPercent,
    status: "pending",
    checkoutSessionId: session.id,
    currency: session.currency,
    subtotalMinor: subtotal,
    rewardMinor: rewardFor(subtotal),
    createdAt: new Date(),
  };
  await platform.referrals.insertOne(referral).catch((err) => {
    if (!isDuplicate(err)) throw err;
  });
  const pending = await platform.referrals.findOne({
    refereeTenantId,
    status: "pending",
  });
  if (!pending) return;
  const referrer = await platform.tenants.findOne({
    _id: pending.referrerTenantId,
  });
  const customer = referrer?.billing?.stripeCustomerId;
  if (!customer || pending.rewardMinor === 0) {
    await platform.referrals.updateOne(
      { _id: pending._id, status: "pending" },
      { $set: { status: "skipped" } },
    );
    return;
  }
  const credit = await call((stripe) =>
    stripe.customers.createBalanceTransaction(
      customer,
      {
        amount: -pending.rewardMinor,
        currency: pending.currency,
        description: "Crédito por referido",
        metadata: { referralId: pending._id.toHexString() },
      },
      { idempotencyKey: `referral-reward-${pending._id}` },
    ),
  );
  await platform.referrals.updateOne(
    { _id: pending._id, status: "pending" },
    {
      $set: {
        status: "rewarded",
        stripeBalanceTransactionId: credit.id,
        rewardedAt: new Date(),
      },
    },
  );
}

async function checkoutCompleted(session: Stripe.Checkout.Session) {
  if (session.mode !== "subscription" || session.payment_status !== "paid") {
    return;
  }
  const tenantId = idOf(session.client_reference_id);
  const customer = idOfRef(session.customer);
  const subscription = idOfRef(session.subscription);
  const tenant =
    tenantId && (await platform.tenants.findOne({ _id: tenantId }));
  if (!tenant || !customer || !subscription) return;
  await platform.tenants.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "billing.stripeCustomerId": customer,
        "billing.stripeSubscriptionId": subscription,
        updatedAt: new Date(),
      },
      $min: { "billing.firstPaidAt": new Date() },
    },
  );
  await syncSubscription(subscription);
  await rewardReferral(session, tenant._id);
}

/** Platform-account events about subscriptions. Connected-account events belong to features/payments. */
export async function handleBillingEvent(event: Stripe.Event) {
  if (event.account || !subscriptionPrice()) return;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await checkoutCompleted(event.data.object);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object.id);
      break;
    default:
      break;
  }
}
