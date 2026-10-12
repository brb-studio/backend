import type { ObjectId } from "mongodb";
import {
  type AppointmentDoc,
  type CustomerDoc,
  forTenant,
  type PaymentDoc,
  type PaymentKind,
  type TenantDb,
  type TenantDoc,
} from "../../db/scoped";
import { AppError } from "../../shared/http";
import { depositOf, onlinePaymentsReady } from "./connect";
import {
  attachIntent,
  newPayment,
  type OnlineMethod,
  onlineCurrencyFor,
  replacePayment,
  stripeFeeOf,
  unavailable,
} from "./holds";
import { customerRefundable, onlineOffer, transferFits } from "./rules";
import {
  abandon,
  currentPayment,
  instructionsOf,
  refundPayment,
  settleIntent,
  sweepHolds,
} from "./settle";
import { type FormParams, providerError, stripe } from "./stripe/client";
import {
  customer as customerSchema,
  paymentIntent,
  type StripePaymentIntent,
} from "./stripe/types";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

/** The Stripe Customer behind a customer's bank transfers; created once, on the platform account. */
async function stripeCustomerFor(t: TenantDb, customer: CustomerDoc) {
  if (customer.stripeCustomerId) return customer.stripeCustomerId;
  const created = await stripe.post(
    customerSchema,
    "/v1/customers",
    {
      name: customer.name,
      ...(customer.phone && { phone: customer.phone }),
      ...(customer.email && { email: customer.email }),
      metadata: {
        tenantId: customer.tenantId.toHexString(),
        customerId: customer._id.toHexString(),
      },
    },
    `customer-${customer._id.toHexString()}`,
  );
  await t.customers.updateOne(
    { _id: customer._id, stripeCustomerId: { $exists: false } },
    { $set: { stripeCustomerId: created.id, updatedAt: new Date() } },
  );
  const saved = await t.customers.findOne({ _id: customer._id });
  return saved?.stripeCustomerId ?? created.id;
}

/** The PaymentIntent for a payment: a destination charge to the shop, keeping the fee that covers Stripe's. */
function intentParams(
  tenant: TenantDoc,
  payment: PaymentDoc,
  customerId: string | undefined,
): FormParams {
  const info = payment.stripe;
  if (!info) throw unavailable();
  const transfer = payment.method === "bank_transfer";
  return {
    amount: payment.amountMinor,
    currency: payment.currency.toLowerCase(),
    // Cards include Apple Pay and Google Pay; Link is Stripe's own wallet.
    allowed_payment_method_types: transfer
      ? ["customer_balance"]
      : ["card", "link"],
    transfer_data: { destination: info.accountId },
    application_fee_amount: info.applicationFeeMinor,
    description: tenant.name.slice(0, 200),
    metadata: {
      tenantId: tenant._id.toHexString(),
      appointmentId: payment.appointmentId.toHexString(),
      paymentId: payment._id.toHexString(),
      kind: payment.kind ?? "full",
    },
    ...(transfer &&
      customerId && {
        customer: customerId,
        payment_method_data: { type: "customer_balance" },
        payment_method_options: {
          customer_balance: {
            funding_type: "bank_transfer",
            bank_transfer: { type: "mx_bank_transfer" },
          },
        },
        confirm: true,
      }),
  };
}

export type Checkout = ReturnType<typeof checkoutView>;

export function checkoutView(
  appointment: Pick<
    AppointmentDoc,
    "_id" | "status" | "totalMinor" | "currency" | "paymentDeadline"
  >,
  payment: PaymentDoc,
  clientSecret?: string | null,
) {
  const instructions = payment.stripe?.instructions;
  return {
    appointmentId: appointment._id.toHexString(),
    appointmentStatus: appointment.status,
    paymentId: payment._id.toHexString(),
    method: payment.method,
    kind: payment.kind ?? "full",
    status: payment.status,
    amountMinor: payment.amountMinor,
    totalMinor: appointment.totalMinor,
    balanceMinor: Math.max(0, appointment.totalMinor - payment.amountMinor),
    /** What the customer gets back cancelling in time: Stripe's fee is not refundable. */
    refundableMinor: customerRefundable(
      payment.amountMinor - (payment.stripe?.refundedMinor ?? 0),
      stripeFeeOf(payment),
    ),
    currency: appointment.currency,
    deadline: appointment.paymentDeadline ?? payment.expiresAt,
    ...(payment.stripe?.cardBrand && { cardBrand: payment.stripe.cardBrand }),
    ...(payment.stripe?.cardLast4 && { cardLast4: payment.stripe.cardLast4 }),
    ...(clientSecret && { clientSecret }),
    ...(instructions && {
      transfer: {
        clabe: instructions.clabe,
        bankName: instructions.bankName ?? null,
        reference: instructions.reference ?? null,
        amountRemainingMinor: instructions.amountRemainingMinor,
        hostedUrl: instructions.hostedUrl ?? null,
      },
    }),
  };
}

/**
 * After the booking committed: asks Stripe for the charge. If Stripe can't be reached the hold is
 * released at once, so a failed attempt never keeps a slot taken.
 */
export async function startCharge(
  tenant: TenantDoc,
  appointment: AppointmentDoc,
  payment: PaymentDoc,
  customer: CustomerDoc,
) {
  const t = forTenant(tenant._id);
  let pi: StripePaymentIntent;
  let customerId: string | undefined;
  try {
    customerId =
      payment.method === "bank_transfer"
        ? await stripeCustomerFor(t, customer)
        : undefined;
    pi = await stripe.post(
      paymentIntent,
      "/v1/payment_intents",
      intentParams(tenant, payment, customerId),
      `pi-${payment._id.toHexString()}`,
    );
  } catch (err) {
    await abandon(tenant, appointment._id, "payment_not_started");
    throw providerError(err, "stripe_payment_failed");
  }
  const instructions = instructionsOf(pi);
  await attachIntent(tenant, payment, {
    paymentIntentId: pi.id,
    ...(customerId && { customerId }),
    ...(instructions && { instructions }),
  });
  const attached = await t.payments.findOne({ _id: payment._id });
  if (!attached) throw notFound();
  // A customer with money already in their Stripe balance pays at once.
  if (pi.status === "succeeded") await settleIntent(tenant, attached, pi);
  const [fresh, latest] = await Promise.all([
    t.appointments.findOne({ _id: appointment._id }),
    t.payments.findOne({ _id: payment._id }),
  ]);
  return checkoutView(
    fresh ?? appointment,
    latest ?? attached,
    payment.method === "card" ? pi.client_secret : undefined,
  );
}

/** What the payment screen polls: the state, and while unpaid how to pay (card secret or CLABE). */
export async function checkoutStatus(
  tenant: TenantDoc,
  appointmentId: ObjectId,
  withSecret = false,
) {
  await sweepHolds(tenant);
  const t = forTenant(tenant._id);
  const appointment = await t.appointments.findOne({ _id: appointmentId });
  if (!appointment) throw notFound();
  const payment = await currentPayment(t, appointment);
  const intentId = payment.stripe?.paymentIntentId;
  const payable =
    withSecret &&
    appointment.status === "pending_payment" &&
    payment.method === "card" &&
    payment.status === "pending" &&
    intentId;
  if (!payable) return checkoutView(appointment, payment);
  try {
    const pi = await stripe.get(
      paymentIntent,
      `/v1/payment_intents/${encodeURIComponent(intentId)}`,
    );
    return checkoutView(appointment, payment, pi.client_secret);
  } catch (err) {
    throw providerError(err, "stripe_payment_read_failed");
  }
}

/** Switches how (card ↔ transfer) or how much (deposit ↔ full) an unpaid booking is paid, same deadline. */
export async function switchPayment(
  tenant: TenantDoc,
  appointmentId: ObjectId,
  choice: { method: OnlineMethod; kind: PaymentKind },
) {
  await sweepHolds(tenant);
  if (!onlinePaymentsReady(tenant)) throw unavailable();
  const currency = onlineCurrencyFor(tenant.currency, choice.method);
  const t = forTenant(tenant._id);
  const appointment = await t.appointments.findOne({ _id: appointmentId });
  if (appointment?.status !== "pending_payment") {
    throw new AppError(
      409,
      "NOT_PENDING_PAYMENT",
      "This booking is no longer waiting for a payment",
    );
  }
  const previous = await currentPayment(t, appointment);
  const deadline = appointment.paymentDeadline ?? previous.expiresAt;
  if (
    choice.method === "bank_transfer" &&
    !transferFits(appointment.startAt, deadline)
  ) {
    throw new AppError(
      409,
      "TRANSFER_TOO_LATE",
      "A transfer can't arrive before this appointment",
    );
  }
  const offer = onlineOffer(
    appointment.totalMinor,
    depositOf(tenant),
    currency,
  );
  const accountId = tenant.stripeConnect?.accountId;
  if (!offer || !accountId) throw unavailable();
  const previousIntent = previous.stripe?.paymentIntentId;
  if (previousIntent) {
    const pi = await stripe
      .post(
        paymentIntent,
        `/v1/payment_intents/${encodeURIComponent(previousIntent)}/cancel`,
        { cancellation_reason: "abandoned" },
      )
      .catch((err: unknown) => {
        throw providerError(err, "stripe_cancel_failed");
      });
    if (pi.status === "succeeded") {
      await settleIntent(tenant, previous, pi);
      throw new AppError(409, "ALREADY_PAID", "This visit is already paid");
    }
  }
  const now = new Date();
  const next = await replacePayment(tenant, previous, (feeDebtMinor) =>
    newPayment(
      appointment,
      offer,
      { ...choice, deadline, accountId },
      now,
      feeDebtMinor,
    ),
  );
  const customer = await t.customers.findOne({ _id: appointment.customerId });
  if (!customer) throw notFound();
  return startCharge(tenant, appointment, next, customer);
}

/** Owner/admin refund from the appointment's detail: the whole remaining amount unless they say less. */
export async function refundAppointment(
  tenant: TenantDoc,
  appointmentId: ObjectId,
  by: ObjectId,
  amountMinor?: number,
) {
  const t = forTenant(tenant._id);
  const appointment = await t.appointments.findOne({ _id: appointmentId });
  if (!appointment) throw notFound();
  const payment = await currentPayment(t, appointment);
  const left = payment.amountMinor - (payment.stripe?.refundedMinor ?? 0);
  // The barbershop chose to refund: it pays the fee the platform can't get back.
  await refundPayment(tenant, payment, amountMinor ?? left, "refund", {
    shopPays: true,
    by,
  });
  const fresh = await t.payments.findOne({ _id: payment._id });
  return checkoutView(appointment, fresh ?? payment);
}
