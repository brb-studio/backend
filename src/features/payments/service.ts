import { ObjectId, type WithId } from "mongodb";
import {
  type AppointmentDoc,
  type CustomerDoc,
  forTenant,
  type PaymentDoc,
  type PaymentStatus,
  platform,
  type TenantDoc,
  transaction,
} from "../../db/scoped";
import { collect, mapBy } from "../../shared/cursor";
import { AppError, isDuplicate } from "../../shared/http";

const EXPIRES_AFTER_MS = 48 * 60 * 60 * 1000;

export function bankSettingsOf(tenant: TenantDoc) {
  return {
    bankTransferEnabled: tenant.bankTransferEnabled === true,
    bankAccountKey: tenant.bankAccountKey ?? null,
    bankAccountHolder: tenant.bankAccountHolder ?? null,
  };
}

export async function saveBankSettings(
  tenant: TenantDoc,
  input: {
    bankTransferEnabled: boolean;
    bankAccountKey?: string;
    bankAccountHolder?: string;
  },
) {
  const { bankAccountKey, bankAccountHolder } = input;
  await platform.tenants.updateOne(
    { _id: tenant._id },
    {
      $set: {
        bankTransferEnabled: input.bankTransferEnabled,
        ...(bankAccountKey && { bankAccountKey }),
        ...(bankAccountHolder && { bankAccountHolder }),
        updatedAt: new Date(),
      },
      $unset: {
        ...(!bankAccountKey && { bankAccountKey: "" }),
        ...(!bankAccountHolder && { bankAccountHolder: "" }),
      },
    },
  );
  return {
    bankTransferEnabled: input.bankTransferEnabled,
    bankAccountKey: bankAccountKey ?? null,
    bankAccountHolder: bankAccountHolder ?? null,
  };
}

export const transfersAvailable = (tenant: TenantDoc) =>
  tenant.bankTransferEnabled === true &&
  Boolean(tenant.bankAccountKey && tenant.bankAccountHolder);

const view = (p: PaymentDoc) => ({
  id: p._id.toHexString(),
  appointmentId: p.appointmentId.toHexString(),
  status: p.status,
  amountMinor: p.amountMinor,
  currency: p.currency,
  holder: p.bank?.holder ?? null,
  clabe: p.bank?.clabe ?? null,
  createdAt: p.createdAt,
  expiresAt: p.expiresAt,
  ...(p.reference && { reference: p.reference }),
  ...(p.resolvedAt && { resolvedAt: p.resolvedAt }),
  ...(p.rejectionReason && { rejectionReason: p.rejectionReason }),
});

/** Manual transfers only: online payments expire with their booking (`payments/holds.ts`). */
export async function expireStale(tenantId: ObjectId) {
  const t = forTenant(tenantId);
  const now = new Date();
  const stale = await collect(
    t.payments
      .find({ method: "spei", status: "pending", expiresAt: { $lte: now } })
      .project<Pick<PaymentDoc, "_id" | "appointmentId">>({
        appointmentId: 1,
      }),
  );
  for (const { _id, appointmentId } of stale) {
    await transaction(async (session) => {
      const { matchedCount } = await t.payments.updateOne(
        { _id, status: "pending" },
        {
          $set: { status: "expired", resolvedAt: now },
          $push: { history: { status: "expired", at: now } },
        },
        { session },
      );
      if (matchedCount === 0) return;
      await t.appointments.updateOne(
        { _id: appointmentId, "payment.paymentId": _id },
        { $set: { "payment.status": "expired", updatedAt: now } },
        { session },
      );
    });
  }
}

export async function createTransfer(
  tenant: TenantDoc,
  appointmentId: ObjectId,
) {
  const { bankAccountKey: clabe, bankAccountHolder: holder } = tenant;
  if (!clabe || !holder || !transfersAvailable(tenant)) {
    throw new AppError(
      409,
      "TRANSFER_NOT_AVAILABLE",
      "This business does not accept bank transfers",
    );
  }
  const t = forTenant(tenant._id);
  await expireStale(tenant._id);
  const appointment = await t.appointments.findOne({ _id: appointmentId });
  if (appointment?.status !== "confirmed") {
    throw new AppError(404, "NOT_FOUND", "Not found");
  }
  if (appointment.totalMinor <= 0) {
    throw new AppError(422, "NOTHING_TO_CHARGE", "This visit has no amount");
  }
  if (appointment.payment?.status === "paid") {
    throw new AppError(409, "ALREADY_PAID", "This visit is already paid");
  }
  const open = () =>
    t.payments.findOne({ appointmentId: appointment._id, status: "pending" });
  const existing = await open();
  if (existing) return view(existing);

  const now = new Date();
  const payment: PaymentDoc = {
    _id: new ObjectId(),
    tenantId: tenant._id,
    appointmentId: appointment._id,
    method: "spei",
    status: "pending",
    amountMinor: appointment.totalMinor,
    currency: appointment.currency,
    bank: { clabe, holder },
    createdAt: now,
    expiresAt: new Date(now.getTime() + EXPIRES_AFTER_MS),
    history: [{ status: "pending", at: now }],
  };
  try {
    await transaction(async (session) => {
      const { tenantId: _, ...doc } = payment;
      await t.payments.insertOne(doc, { session });
      await t.appointments.updateOne(
        { _id: appointment._id },
        {
          $set: {
            payment: {
              provider: "spei",
              paymentId: payment._id,
              status: "pending",
              amountMinor: payment.amountMinor,
            },
            updatedAt: now,
          },
        },
        { session },
      );
    });
  } catch (err) {
    const winner = isDuplicate(err) && (await open());
    if (winner) return view(winner);
    throw err;
  }
  return view(payment);
}

type Customer = Pick<CustomerDoc, "name" | "phone">;

export async function listPayments(tenant: TenantDoc, status: PaymentStatus) {
  const t = forTenant(tenant._id);
  await expireStale(tenant._id);
  const payments = await collect(
    t.payments
      .find({ method: "spei", status })
      .sort({ createdAt: -1 })
      .limit(100),
  );
  const appointments = await mapBy(
    t.appointments
      .find({ _id: { $in: payments.map((p) => p.appointmentId) } })
      .project<WithId<Pick<AppointmentDoc, "startAt" | "customerId">>>({
        startAt: 1,
        customerId: 1,
      }),
    (a) => a._id.toHexString(),
  );
  const customers = await mapBy(
    t.customers
      .find({
        _id: {
          $in: [...appointments.values()].map((a) => a.customerId),
        },
      })
      .project<WithId<Customer>>({ name: 1, phone: 1 }),
    (c) => c._id.toHexString(),
  );
  return payments.map((p) => {
    const appointment = appointments.get(p.appointmentId.toHexString());
    const customer = appointment
      ? customers.get(appointment.customerId.toHexString())
      : undefined;
    return {
      ...view(p),
      startAt: appointment?.startAt ?? null,
      customerName: customer?.name ?? null,
      customerPhone: customer?.phone ?? null,
      history: p.history,
    };
  });
}

const invalidTransition = () =>
  new AppError(
    409,
    "INVALID_TRANSITION",
    "This payment was already resolved or has expired",
  );

async function resolve(
  tenant: TenantDoc,
  paymentId: ObjectId,
  staffId: ObjectId,
  status: "paid" | "rejected",
  check: (payment: PaymentDoc, appointment: AppointmentDoc) => void,
  fields: { reference?: string; rejectionReason?: string },
) {
  const t = forTenant(tenant._id);
  await expireStale(tenant._id);
  const payment = await t.payments.findOne({ _id: paymentId, method: "spei" });
  if (!payment) throw new AppError(404, "NOT_FOUND", "Not found");
  if (payment.status !== "pending") throw invalidTransition();
  const appointment = await t.appointments.findOne({
    _id: payment.appointmentId,
  });
  if (!appointment) throw new AppError(404, "NOT_FOUND", "Not found");
  check(payment, appointment);

  const now = new Date();
  await transaction(async (session) => {
    const { matchedCount } = await t.payments.updateOne(
      { _id: payment._id, status: "pending" },
      {
        $set: { status, resolvedAt: now, resolvedBy: staffId, ...fields },
        $push: {
          history: {
            status,
            at: now,
            by: staffId,
            ...(fields.rejectionReason && { note: fields.rejectionReason }),
          },
        },
      },
      { session },
    );
    if (matchedCount === 0) throw invalidTransition();
    await t.appointments.updateOne(
      { _id: appointment._id, "payment.paymentId": payment._id },
      {
        $set: {
          "payment.status": status,
          ...(status === "paid" && { "payment.paidAt": now }),
          updatedAt: now,
        },
      },
      { session },
    );
  });
  const resolved = await t.payments.findOne({ _id: payment._id });
  if (!resolved) throw new AppError(404, "NOT_FOUND", "Not found");
  return view(resolved);
}

export const confirmPayment = (
  tenant: TenantDoc,
  staffId: ObjectId,
  paymentId: ObjectId,
  input: { receivedMinor: number; reference?: string },
) =>
  resolve(
    tenant,
    paymentId,
    staffId,
    "paid",
    (payment, appointment) => {
      if (input.receivedMinor !== payment.amountMinor) {
        throw new AppError(
          422,
          "AMOUNT_MISMATCH",
          "The amount received does not match the amount owed",
        );
      }
      if (appointment.totalMinor !== payment.amountMinor) {
        throw new AppError(
          409,
          "AMOUNT_CHANGED",
          "The appointment total changed since this transfer was requested",
        );
      }
      if (
        appointment.status !== "confirmed" &&
        appointment.status !== "completed"
      ) {
        throw new AppError(
          409,
          "APPOINTMENT_NOT_PAYABLE",
          "This appointment was cancelled",
        );
      }
    },
    input.reference ? { reference: input.reference } : {},
  );

export const rejectPayment = (
  tenant: TenantDoc,
  staffId: ObjectId,
  paymentId: ObjectId,
  input: { reason?: string },
) =>
  resolve(
    tenant,
    paymentId,
    staffId,
    "rejected",
    () => {},
    input.reason ? { rejectionReason: input.reason } : {},
  );
