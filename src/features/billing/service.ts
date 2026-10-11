import { ObjectId, type WithId } from "mongodb";
import type * as z from "zod";
import { config } from "../../config";
import { hit } from "../../db/rate-limit";
import {
  forTenant,
  platform,
  type ReferralDoc,
  type SubscriptionPaymentDoc,
  type TenantDoc,
  transaction,
} from "../../db/scoped";
import { collect, mapBy } from "../../shared/cursor";
import { AppError, isDuplicate } from "../../shared/http";
import { isValidClabe } from "../payments/clabe";
import { PLAN_LIMITS } from "../tenancy/subscription";
import {
  isPaidUp,
  newReferralCode,
  periodEnd,
  REFERRAL,
  rewardFor,
  SUBSCRIPTION_PLAN,
} from "./rules";
import type { paymentInput } from "./schemas";

const HOUR_MS = 60 * 60 * 1000;
/** A subscription transfer not confirmed within this long expires; the owner can start a new one. */
const EXPIRES_AFTER_MS = 5 * 24 * HOUR_MS;

const price = () => ({
  amountMinor: config.SUBSCRIPTION_PRICE_MINOR,
  currency: config.SUBSCRIPTION_CURRENCY,
  interval: "month" as const,
});

const ownerOf = (tenantId: ObjectId) =>
  forTenant(tenantId).users.findOne({ role: "owner" });

/** The project owner's account (collection `ownerProject`), checked on every use: a typo here sends money nowhere. */
async function receivingAccount() {
  const owner = await platform.ownerProject.findOne({
    active: true,
    bankAccountKey: { $exists: true },
  });
  const clabe = owner?.bankAccountKey;
  if (!owner || !clabe || !isValidClabe(clabe)) {
    throw new AppError(
      503,
      "BILLING_DISABLED",
      "The platform has no valid bank account to receive subscriptions",
    );
  }
  return { clabe, holder: owner.name };
}

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

const view = (p: SubscriptionPaymentDoc) => ({
  id: p._id.toHexString(),
  status: p.status,
  amountMinor: p.amountMinor,
  listPriceMinor: p.listPriceMinor,
  discountMinor: p.discountMinor,
  creditAppliedMinor: p.creditAppliedMinor,
  currency: p.currency,
  holder: p.bank.holder,
  clabe: p.bank.clabe,
  createdAt: p.createdAt,
  expiresAt: p.expiresAt,
  ...(p.referral && { referralCode: p.referral.code }),
  ...(p.reference && { reference: p.reference }),
  ...(p.resolvedAt && { resolvedAt: p.resolvedAt }),
  ...(p.rejectionReason && { rejectionReason: p.rejectionReason }),
});

/** Unconfirmed transfers past their deadline become `expired`; nothing else depends on it. */
async function expireStale() {
  const now = new Date();
  await platform.subscriptionPayments.updateMany(
    { status: "pending", expiresAt: { $lte: now } },
    {
      $set: { status: "expired", resolvedAt: now },
      $push: { history: { status: "expired", at: now } },
    },
  );
}

const pendingOf = (tenantId: ObjectId) =>
  platform.subscriptionPayments.findOne({ tenantId, status: "pending" });

export async function billingSummary(tenant: TenantDoc) {
  await expireStale();
  const code = await ensureReferralCode(tenant);
  const stats = { referred: 0, rewarded: 0, earnedMinor: 0 };
  const referrals = platform.referrals
    .find({ referrerTenantId: tenant._id })
    .project<Pick<ReferralDoc, "status" | "rewardMinor">>({
      status: 1,
      rewardMinor: 1,
    });
  for await (const referral of referrals) {
    stats.referred++;
    if (referral.status === "rewarded") {
      stats.rewarded++;
      stats.earnedMinor += referral.rewardMinor;
    }
  }
  const [referredBy, pending] = await Promise.all([
    platform.referrals.findOne({ refereeTenantId: tenant._id }),
    pendingOf(tenant._id),
  ]);
  return {
    price: price(),
    plan: tenant.subscription.plan,
    status: tenant.subscription.status,
    currentPeriodEnd: tenant.subscription.currentPeriodEnd,
    subscribed: isPaidUp(tenant, new Date()),
    creditMinor: tenant.billing?.creditMinor ?? 0,
    pending: pending ? view(pending) : null,
    referral: {
      code: code ?? null,
      friendPercent: REFERRAL.friendPercent,
      rewardPercent: REFERRAL.rewardPercent,
      referred: stats.referred,
      rewarded: stats.rewarded,
      earnedMinor: stats.earnedMinor,
    },
    ...(referredBy && {
      referredBy: { discountPercent: referredBy.discountPercent },
    }),
  };
}

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

/**
 * The owner asks to pay a month. The amount is the list price minus the friend's discount (first month
 * only) minus referral credit, all computed here; the account is the project owner's, copied into the
 * payment so later edits can't redirect it. Asking again while one is pending returns the same one.
 */
export async function createPayment(
  tenant: TenantDoc,
  input: z.output<typeof paymentInput>,
) {
  if (tenant.subscription.plan === "lifetime") {
    throw new AppError(409, "LIFETIME_PLAN", "This barbershop never pays");
  }
  await expireStale();
  const existing = await pendingOf(tenant._id);
  if (existing) return view(existing);
  const referral =
    input.referralCode !== undefined
      ? await checkReferral(tenant, input.referralCode)
      : undefined;
  if (!(await hit(`pay-subscription:${tenant._id}`, 10, HOUR_MS))) {
    throw new AppError(
      429,
      "RATE_LIMITED",
      "Too many attempts, try again later",
    );
  }
  const bank = await receivingAccount();
  const { amountMinor: listPriceMinor, currency } = price();
  const discountMinor = referral
    ? Math.round((listPriceMinor * REFERRAL.friendPercent) / 100)
    : 0;
  const creditAppliedMinor = Math.min(
    tenant.billing?.creditMinor ?? 0,
    listPriceMinor - discountMinor,
  );
  const now = new Date();
  const payment: SubscriptionPaymentDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    status: "pending",
    amountMinor: listPriceMinor - discountMinor - creditAppliedMinor,
    listPriceMinor,
    discountMinor,
    creditAppliedMinor,
    currency,
    bank,
    ...(referral && {
      referral: {
        referrerTenantId: referral.referrer._id,
        code: referral.code,
        discountPercent: referral.discountPercent,
      },
    }),
    createdAt: now,
    expiresAt: new Date(now.getTime() + EXPIRES_AFTER_MS),
    history: [{ status: "pending", at: now }],
  };
  try {
    await platform.subscriptionPayments.insertOne(payment);
  } catch (err) {
    // Two requests raced: the unique index let only one in, so hand back the winner.
    const winner = isDuplicate(err) && (await pendingOf(tenant._id));
    if (winner) return view(winner);
    throw err;
  }
  // Credit covering the whole month leaves nothing to transfer: it is settled right away.
  if (payment.amountMinor === 0) return view(await settle(payment._id));
  return view(payment);
}

const invalidTransition = () =>
  new AppError(
    409,
    "INVALID_TRANSITION",
    "This payment was already resolved or has expired",
  );

/**
 * pending → paid, once, in one transaction: the payment, the new period and plan, the credit spent, and
 * the referral reward. The status filter makes a repeated call change nothing.
 */
async function settle(
  paymentId: ObjectId,
  staffId?: ObjectId,
  reference?: string,
) {
  const now = new Date();
  return transaction(async (session) => {
    const payment = await platform.subscriptionPayments.findOne(
      { _id: paymentId },
      { session },
    );
    if (!payment) throw new AppError(404, "NOT_FOUND", "Not found");
    if (payment.status !== "pending") throw invalidTransition();
    const { matchedCount } = await platform.subscriptionPayments.updateOne(
      { _id: payment._id, status: "pending" },
      {
        $set: {
          status: "paid",
          resolvedAt: now,
          ...(staffId && { resolvedBy: staffId }),
          ...(reference && { reference }),
        },
        $push: {
          history: { status: "paid", at: now, ...(staffId && { by: staffId }) },
        },
      },
      { session },
    );
    if (matchedCount === 0) throw invalidTransition();

    const tenant = await platform.tenants.findOne(
      { _id: payment.tenantId },
      { session },
    );
    if (!tenant) throw new AppError(404, "NOT_FOUND", "Not found");
    const credit = payment.creditAppliedMinor;
    const updated = await platform.tenants.updateOne(
      {
        _id: tenant._id,
        ...(credit > 0 && { "billing.creditMinor": { $gte: credit } }),
      },
      {
        $set: {
          "subscription.plan": SUBSCRIPTION_PLAN,
          "subscription.status": "active",
          "subscription.limits": PLAN_LIMITS[SUBSCRIPTION_PLAN],
          "subscription.currentPeriodEnd": periodEnd(
            tenant.subscription.currentPeriodEnd,
            now,
          ),
          updatedAt: now,
        },
        $min: { "billing.firstPaidAt": now },
        ...(credit > 0 && { $inc: { "billing.creditMinor": -credit } }),
      },
      { session },
    );
    if (updated.matchedCount === 0) {
      throw new AppError(
        409,
        "CREDIT_CHANGED",
        "The referral credit changed since this payment was requested",
      );
    }

    const alreadyReferred = await platform.referrals.findOne(
      { refereeTenantId: tenant._id },
      { session },
    );
    if (payment.referral && !alreadyReferred) {
      const rewardMinor = rewardFor(payment.listPriceMinor);
      const referral: ReferralDoc = {
        _id: new ObjectId(),
        referrerTenantId: payment.referral.referrerTenantId,
        refereeTenantId: tenant._id,
        code: payment.referral.code,
        discountPercent: payment.referral.discountPercent,
        status: rewardMinor > 0 ? "rewarded" : "skipped",
        paymentId: payment._id,
        currency: payment.currency,
        subtotalMinor: payment.listPriceMinor,
        rewardMinor,
        createdAt: now,
        ...(rewardMinor > 0 && { rewardedAt: now }),
      };
      await platform.referrals.insertOne(referral, { session });
      if (rewardMinor > 0) {
        await platform.tenants.updateOne(
          { _id: referral.referrerTenantId },
          { $inc: { "billing.creditMinor": rewardMinor } },
          { session },
        );
      }
    }
    const settled = await platform.subscriptionPayments.findOne(
      { _id: payment._id },
      { session },
    );
    if (!settled) throw new AppError(404, "NOT_FOUND", "Not found");
    return settled;
  });
}

// ---------- platform staff ----------

type TenantName = Pick<TenantDoc, "name" | "slug">;

export async function listPayments(status: SubscriptionPaymentDoc["status"]) {
  await expireStale();
  const payments = await collect(
    platform.subscriptionPayments
      .find({ status })
      .sort({ createdAt: -1 })
      .limit(100),
  );
  const tenants = await mapBy(
    platform.tenants
      .find({ _id: { $in: payments.map((p) => p.tenantId) } })
      .project<WithId<TenantName>>({ name: 1, slug: 1 }),
    (t) => t._id.toHexString(),
  );
  return payments.map((p) => {
    const tenant = tenants.get(p.tenantId.toHexString());
    return {
      ...view(p),
      tenantName: tenant?.name ?? null,
      tenantSlug: tenant?.slug ?? null,
      history: p.history,
    };
  });
}

export async function confirmPayment(
  staffId: ObjectId,
  paymentId: ObjectId,
  input: { receivedMinor: number; reference?: string },
) {
  await expireStale();
  const payment = await platform.subscriptionPayments.findOne({
    _id: paymentId,
  });
  if (!payment) throw new AppError(404, "NOT_FOUND", "Not found");
  if (payment.status !== "pending") throw invalidTransition();
  if (input.receivedMinor !== payment.amountMinor) {
    throw new AppError(
      422,
      "AMOUNT_MISMATCH",
      "The amount received does not match the amount owed",
    );
  }
  return view(await settle(payment._id, staffId, input.reference));
}

export async function rejectPayment(
  staffId: ObjectId,
  paymentId: ObjectId,
  input: { reason?: string },
) {
  await expireStale();
  const now = new Date();
  const rejected = await platform.subscriptionPayments.findOneAndUpdate(
    { _id: paymentId, status: "pending" },
    {
      $set: {
        status: "rejected",
        resolvedAt: now,
        resolvedBy: staffId,
        ...(input.reason && { rejectionReason: input.reason }),
      },
      $push: {
        history: {
          status: "rejected",
          at: now,
          by: staffId,
          ...(input.reason && { note: input.reason }),
        },
      },
    },
    { returnDocument: "after" },
  );
  if (rejected) return view(rejected);
  if (!(await platform.subscriptionPayments.findOne({ _id: paymentId }))) {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  throw invalidTransition();
}
