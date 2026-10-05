import type { ObjectId } from "mongodb";
import type Stripe from "stripe";
import { config } from "../../config";
import {
  type AppointmentDoc,
  forTenant,
  platform,
  type TenantDoc,
} from "../../db/scoped";
import { AppError } from "../../shared/http";
import { requireStripe } from "./stripe";

const notConnected = () =>
  new AppError(
    409,
    "STRIPE_NOT_CONNECTED",
    "This business hasn't connected Stripe yet",
  );

function feeFor(amountMinor: number) {
  const bps = config.STRIPE_APP_FEE_BPS;
  return bps > 0 ? Math.floor((amountMinor * bps) / 10_000) : 0;
}

const ACCOUNT_INCLUDE = [
  "configuration.merchant",
  "identity",
  "requirements",
] as ("configuration.merchant" | "identity" | "requirements")[];

const retrieveAccount = (
  stripe: ReturnType<typeof requireStripe>,
  id: string,
) => stripe.v2.core.accounts.retrieve(id, { include: ACCOUNT_INCLUDE });

export async function ensureConnectAccount(tenant: TenantDoc): Promise<string> {
  if (tenant.stripe?.accountId) return tenant.stripe.accountId;
  const stripe = requireStripe();
  const account = await stripe.v2.core.accounts.create({
    dashboard: "none",
    defaults: {
      currency: tenant.currency.toLowerCase(),
      responsibilities: {
        fees_collector: "application",
        losses_collector: "stripe",
      },
    },
    display_name: tenant.name,
    identity: { country: "MX", entity_type: "individual" },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
    },
    metadata: { tenantId: tenant._id.toHexString(), slug: tenant.slug },
  });
  await platform.tenants.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "stripe.accountId": account.id,
        "stripe.detailsSubmitted": false,
        "stripe.chargesEnabled": false,
        updatedAt: new Date(),
      },
    },
  );
  return account.id;
}

export async function createOnboardingLink(tenant: TenantDoc) {
  if (!config.FRONTEND_URL) {
    throw new AppError(
      503,
      "PAYMENTS_DISABLED",
      "FRONTEND_URL is not configured for Stripe onboarding",
    );
  }
  const stripe = requireStripe();
  const accountId = await ensureConnectAccount(tenant);
  const base = config.FRONTEND_URL.replace(/\/$/, "");
  const [link, account] = await Promise.all([
    stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          refresh_url: `${base}/dashboard/pagos?stripe=refresh`,
          return_url: `${base}/dashboard/pagos?stripe=return`,
        },
      },
    }),
    retrieveAccount(stripe, accountId),
  ]);
  await syncAccountToTenant(tenant._id, account);
  return { accountId, url: link.url };
}

export async function connectStatus(tenant: TenantDoc) {
  const accountId = tenant.stripe?.accountId;
  if (!accountId) {
    return { connected: false as const, accountId: null as string | null };
  }
  const stripe = requireStripe();
  try {
    const account = await retrieveAccount(stripe, accountId);
    const updated = await syncAccountToTenant(tenant._id, account);
    return {
      connected: updated.chargesEnabled === true,
      accountId,
      detailsSubmitted: updated.detailsSubmitted ?? false,
      chargesEnabled: updated.chargesEnabled ?? false,
    };
  } catch {
    return {
      connected: false as const,
      accountId,
      detailsSubmitted: tenant.stripe?.detailsSubmitted ?? false,
      chargesEnabled: false as const,
    };
  }
}

type ConnectedState = {
  accountId: string;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
};

function accountState(account: {
  id: string;
  configuration?: {
    merchant?: { capabilities?: { card_payments?: { status?: string } } };
  };
  requirements?: { entries?: { awaiting_action_from?: string }[] };
}): ConnectedState {
  const cardStatus =
    account.configuration?.merchant?.capabilities?.card_payments?.status;
  const entries = account.requirements?.entries ?? [];
  const detailsSubmitted =
    cardStatus === "active" ||
    (entries.length > 0 &&
      entries.every((entry) => entry.awaiting_action_from !== "user"));
  const chargesEnabled = cardStatus === "active";
  return { accountId: account.id, detailsSubmitted, chargesEnabled };
}

async function syncAccountToTenant(
  tenantId: ObjectId,
  account: Parameters<typeof accountState>[0],
) {
  const state = accountState(account);
  await platform.tenants.updateOne(
    { _id: tenantId },
    {
      $set: {
        stripe: {
          ...state,
          ...(state.detailsSubmitted &&
            state.chargesEnabled && { onboardedAt: new Date() }),
        },
        updatedAt: new Date(),
      },
    },
  );
  return state;
}

/** Authoritative refresh from a v2 account notification (thin event). */
export async function syncAccountById(accountId: string) {
  const tenant = await platform.tenants.findOne({
    "stripe.accountId": accountId,
  });
  if (!tenant) return;
  const account = await retrieveAccount(requireStripe(), accountId);
  await syncAccountToTenant(tenant._id, account);
}

export async function createPaymentIntent(
  tenant: TenantDoc,
  appointmentId: ObjectId,
) {
  const accountId = tenant.stripe?.accountId;
  if (!accountId || tenant.stripe?.chargesEnabled !== true) {
    throw notConnected();
  }
  const t = forTenant(tenant._id);
  const appointment = await t.appointments.findOne({ _id: appointmentId });
  if (appointment?.status !== "confirmed") {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  if (appointment.totalMinor <= 0) {
    throw new AppError(422, "NOTHING_TO_CHARGE", "This visit has no amount");
  }

  const stripe = requireStripe();
  const existing = appointment.payment;

  if (
    existing?.provider === "stripe" &&
    existing.status === "requires_payment"
  ) {
    try {
      const pi = await stripe.paymentIntents.retrieve(
        existing.intentId,
        undefined,
        { stripeAccount: accountId },
      );
      if (
        pi.status === "requires_payment_method" ||
        pi.status === "requires_confirmation" ||
        pi.status === "requires_action"
      ) {
        if (!pi.client_secret) {
          throw new AppError(502, "PAYMENT_ERROR", "Stripe gave no secret");
        }
        return toIntentResponse(tenant, appointment, pi);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // The old intent is gone or unusable: fall through and create a new one.
    }
  }
  if (existing?.status === "paid") {
    throw new AppError(409, "ALREADY_PAID", "This visit is already paid");
  }

  const applicationFee = feeFor(appointment.totalMinor);
  const pi = await stripe.paymentIntents.create(
    {
      amount: appointment.totalMinor,
      currency: tenant.currency.toLowerCase(),
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      ...(applicationFee > 0 && {
        application_fee_amount: applicationFee,
      }),
      metadata: {
        tenantId: tenant._id.toHexString(),
        appointmentId: appointment._id.toHexString(),
      },
      description: `Cita ${appointment._id.toHexString()} · ${tenant.slug}`,
    },
    {
      stripeAccount: accountId,
      idempotencyKey: `pi_${appointment._id.toHexString()}`,
    },
  );
  if (!pi.client_secret) {
    throw new AppError(502, "PAYMENT_ERROR", "Stripe gave no secret");
  }
  await t.appointments.updateOne(
    { _id: appointment._id },
    {
      $set: {
        payment: {
          provider: "stripe",
          intentId: pi.id,
          status: "requires_payment",
          amountMinor: appointment.totalMinor,
          ...(applicationFee > 0 && {
            applicationFeeMinor: applicationFee,
          }),
        },
        updatedAt: new Date(),
      },
    },
  );
  return toIntentResponse(
    tenant,
    { ...appointment, totalMinor: appointment.totalMinor },
    pi,
  );
}

function toIntentResponse(
  tenant: TenantDoc,
  appointment: AppointmentDoc,
  pi: Stripe.PaymentIntent,
) {
  return {
    appointmentId: appointment._id.toHexString(),
    clientSecret: pi.client_secret as string,
    accountId: tenant.stripe?.accountId as string,
    publishableKey: config.STRIPE_PUBLISHABLE_KEY ?? null,
    amountMinor: pi.amount,
    currency: tenant.currency,
    paymentStatus: "requires_payment" as const,
  };
}

export async function refundAppointment(
  tenant: TenantDoc,
  appointmentId: ObjectId,
) {
  const accountId = tenant.stripe?.accountId;
  if (!accountId) throw notConnected();
  const t = forTenant(tenant._id);
  const appointment = await t.appointments.findOne({ _id: appointmentId });
  if (!appointment) throw new AppError(404, "NOT_FOUND", "Not found");
  if (appointment.payment?.status !== "paid") {
    throw new AppError(409, "NOT_PAID", "This visit is not paid");
  }
  const stripe = requireStripe();
  await stripe.refunds.create(
    { payment_intent: appointment.payment.intentId },
    { stripeAccount: accountId },
  );
  await t.appointments.updateOne(
    { _id: appointment._id, "payment.status": "paid" },
    {
      $set: { "payment.status": "refunded", updatedAt: new Date() },
    },
  );
  return {
    appointmentId: appointment._id.toHexString(),
    status: "refunded" as const,
  };
}

async function markPaid(intentId: string) {
  await platform.appointments.updateOne(
    { "payment.intentId": intentId, "payment.status": "requires_payment" },
    {
      $set: {
        "payment.status": "paid",
        "payment.paidAt": new Date(),
        updatedAt: new Date(),
      },
    },
  );
}

async function markFailed(intentId: string) {
  await platform.appointments.updateOne(
    { "payment.intentId": intentId, "payment.status": "requires_payment" },
    {
      $set: { "payment.status": "failed", updatedAt: new Date() },
    },
  );
}

async function markRefunded(intentId: string) {
  await platform.appointments.updateOne(
    { "payment.intentId": intentId, "payment.status": "paid" },
    {
      $set: { "payment.status": "refunded", updatedAt: new Date() },
    },
  );
}

export async function handleStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object;
      await markPaid(pi.id);
      break;
    }
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const pi = event.data.object;
      await markFailed(pi.id);
      break;
    }
    case "charge.refunded": {
      const charge = event.data.object;
      const pi = charge.payment_intent;
      if (typeof pi === "string" && pi.startsWith("pi_")) {
        await markRefunded(pi);
      }
      break;
    }
    case "account.updated": {
      // v1 accounts are gone on new platforms; v2 speaks thin events below.
      break;
    }
    default:
      break;
  }
}

export async function handleThinNotification(
  type: string,
  relatedId: string | undefined,
) {
  if (!type.startsWith("v2.core.account") || !relatedId) return;
  await syncAccountById(relatedId);
}
