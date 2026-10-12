import { config } from "../../config";
import { type Locale, platform, type TenantDoc } from "../../db/scoped";
import { AppError } from "../../shared/http";
import {
  connectStatus,
  type DepositSettings,
  isOnlineCurrency,
  methodsFor,
} from "./rules";
import { providerError, stripe, stripeEnabled } from "./stripe/client";
import {
  account,
  accountLink,
  loginLink,
  type StripeAccount,
} from "./stripe/types";

const DEFAULT_DEPOSIT: DepositSettings = { enabled: false, percentBps: 2_500 };

const disabled = () =>
  new AppError(503, "ONLINE_PAYMENTS_DISABLED", "Online payments are off");

/** Online payments are offered only when the platform has Stripe and Stripe can transfer to the shop. */
export const onlinePaymentsReady = (tenant: TenantDoc) =>
  stripeEnabled() &&
  isOnlineCurrency(tenant.currency) &&
  tenant.stripeConnect?.status === "active";

/** How customers can pay this shop online: cards always, Mexican bank transfers only in pesos. */
export const onlineMethodsOf = (tenant: TenantDoc) =>
  isOnlineCurrency(tenant.currency) ? methodsFor(tenant.currency) : [];

export const depositOf = (tenant: TenantDoc) =>
  tenant.deposit ?? DEFAULT_DEPOSIT;

/** The owner's view: no Stripe ids, only what to do next. */
export const connectView = (tenant: TenantDoc) => ({
  available: stripeEnabled(),
  status: tenant.stripeConnect?.status ?? "none",
  requirementsDue: tenant.stripeConnect?.requirementsDue ?? [],
  updatedAt: tenant.stripeConnect?.updatedAt ?? null,
  /** Fees owed by the shop for refunds it made; taken from its next online payments. */
  feeDebtMinor: tenant.stripeConnect?.feeDebtMinor ?? 0,
  feeDebtCurrency: tenant.stripeConnect?.feeDebtCurrency ?? tenant.currency,
  currency: tenant.currency,
  deposit: depositOf(tenant),
});

/** Where Stripe sends the owner back: the barbershop's own payments page, in its language. */
export const onboardingUrls = (origin: string, locale: Locale) => {
  const page = `${origin}/${locale}/admin/payments`;
  return {
    returnUrl: `${page}?stripe=return`,
    refreshUrl: `${page}?stripe=refresh`,
  };
};

async function createAccount(tenant: TenantDoc, contactEmail: string) {
  const created = await stripe.postJson(
    account,
    "/v2/core/accounts",
    {
      contact_email: contactEmail,
      display_name: tenant.name,
      // The shop doesn't run a Stripe account: Express only to see its deposits; the platform owns
      // pricing and losses (destination charges).
      dashboard: "express",
      identity: { country: "mx" },
      configuration: {
        recipient: {
          capabilities: {
            stripe_balance: { stripe_transfers: { requested: true } },
          },
        },
      },
      defaults: {
        currency: "mxn",
        responsibilities: {
          fees_collector: "application",
          losses_collector: "application",
        },
      },
      metadata: { tenantId: tenant._id.toHexString() },
      include: ["configuration.recipient", "requirements"],
    },
    `account-${tenant._id.toHexString()}`,
  );
  const now = new Date();
  // Two owners clicking at once: the first id saved wins and both continue with it.
  await platform.tenants.updateOne(
    { _id: tenant._id, "stripeConnect.accountId": { $exists: false } },
    {
      $set: {
        stripeConnect: {
          accountId: created.id,
          status: "onboarding",
          requirementsDue: [],
          createdAt: now,
          updatedAt: now,
        },
        updatedAt: now,
      },
    },
  );
  const saved = await platform.tenants.findOne(
    { _id: tenant._id },
    { projection: { stripeConnect: 1 } },
  );
  return saved?.stripeConnect?.accountId ?? created.id;
}

/** Creates the connected account the first time, then a fresh single-use onboarding link (they expire). */
export async function startOnboarding(
  tenant: TenantDoc,
  contactEmail: string,
  urls: { returnUrl: string; refreshUrl: string },
) {
  if (!stripeEnabled()) throw disabled();
  try {
    const accountId =
      tenant.stripeConnect?.accountId ??
      (await createAccount(tenant, contactEmail));
    const link = await stripe.postJson(accountLink, "/v2/core/account_links", {
      account: accountId,
      use_case: {
        type: "account_onboarding",
        // The configurations to collect come from the account itself (recipient); this API version
        // refuses them here.
        account_onboarding: {
          return_url: urls.returnUrl,
          refresh_url: urls.refreshUrl,
        },
      },
    });
    return { url: link.url };
  } catch (err) {
    throw providerError(err, "stripe_onboarding_failed");
  }
}

/** The connected account as Stripe has it now; webhooks only tell us that it changed. */
const fetchAccount = (accountId: string) =>
  stripe.get(
    account,
    `/v2/core/accounts/${encodeURIComponent(accountId)}?include=configuration.recipient&include=requirements`,
  );

export function summarize(
  remote: StripeAccount,
  previous: TenantDoc["stripeConnect"],
) {
  const entries = remote.requirements?.entries ?? [];
  const due = entries
    .filter(
      (entry) =>
        entry.awaiting_action_from !== "stripe" &&
        entry.minimum_deadline?.status !== "eventually_due",
    )
    .map((entry) => entry.description)
    .slice(0, 100);
  const transfers =
    remote.configuration?.recipient?.capabilities?.stripe_balance
      ?.stripe_transfers?.status;
  return {
    status: connectStatus(transfers, due.length > 0, previous?.status),
    requirementsDue: due,
  };
}

/** Saves Stripe's current state of a connected account; unknown accounts are ignored. */
export async function syncAccount(accountId: string) {
  const tenant = await platform.tenants.findOne({
    "stripeConnect.accountId": accountId,
  });
  if (!tenant?.stripeConnect) return undefined;
  const { status, requirementsDue } = summarize(
    await fetchAccount(accountId),
    tenant.stripeConnect,
  );
  const now = new Date();
  await platform.tenants.updateOne(
    { _id: tenant._id, "stripeConnect.accountId": accountId },
    {
      $set: {
        "stripeConnect.status": status,
        "stripeConnect.requirementsDue": requirementsDue,
        "stripeConnect.updatedAt": now,
        updatedAt: now,
      },
    },
  );
  return {
    ...tenant,
    stripeConnect: {
      ...tenant.stripeConnect,
      status,
      requirementsDue,
      updatedAt: now,
    },
  };
}

/** For the owner coming back from Stripe's form: reads the account now instead of waiting for the webhook. */
export async function refreshAccount(tenant: TenantDoc) {
  const accountId = tenant.stripeConnect?.accountId;
  if (!accountId) return connectView(tenant);
  if (!stripeEnabled()) throw disabled();
  try {
    return connectView((await syncAccount(accountId)) ?? tenant);
  } catch (err) {
    throw providerError(err, "stripe_account_sync_failed");
  }
}

/** A one-time link to the shop's Express dashboard (deposits and payouts), once Stripe has the account. */
export async function dashboardLink(tenant: TenantDoc) {
  const accountId = tenant.stripeConnect?.accountId;
  if (!accountId || tenant.stripeConnect?.status === "onboarding") {
    throw new AppError(
      409,
      "ONBOARDING_INCOMPLETE",
      "Finish Stripe's registration first",
    );
  }
  if (!stripeEnabled()) throw disabled();
  try {
    const link = await stripe.post(
      loginLink,
      `/v1/accounts/${encodeURIComponent(accountId)}/login_links`,
      {},
    );
    return { url: link.url };
  } catch (err) {
    throw providerError(err, "stripe_login_link_failed");
  }
}

export async function saveDeposit(tenant: TenantDoc, input: DepositSettings) {
  await platform.tenants.updateOne(
    { _id: tenant._id },
    { $set: { deposit: input, updatedAt: new Date() } },
  );
  return input;
}

export const holdMinutes = () => ({
  card: config.PAYMENT_HOLD_CARD_MIN,
  bank_transfer: config.PAYMENT_HOLD_TRANSFER_MIN,
});
