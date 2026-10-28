import { ObjectId } from "mongodb";
import type * as z from "zod";
import {
  forTenant,
  type InvoiceRequestDoc,
  type TenantDoc,
} from "../../db/scoped";
import { collect } from "../../shared/cursor";
import { AppError, type Auth, isDuplicate } from "../../shared/http";
import type { invoiceReceiver, invoiceUpdate } from "./schemas";

type Receiver = z.output<typeof invoiceReceiver>;
type Update = z.output<typeof invoiceUpdate>;

/** A customer asks for a CFDI for one of their completed visits; the shop issues it in its own system. */
export async function requestInvoice(
  tenant: TenantDoc,
  auth: Auth,
  appointmentId: ObjectId,
  receiver: Receiver,
  now = new Date(),
) {
  if (!tenant.invoicing?.enabled) {
    throw new AppError(
      409,
      "INVOICING_DISABLED",
      "This barbershop does not issue invoices",
    );
  }
  const t = forTenant(auth.tenantId);
  const visit = await t.appointments.findOne({
    _id: appointmentId,
    customerId: auth.userId,
  });
  if (!visit) throw new AppError(404, "NOT_FOUND", "Not found");
  if (visit.status !== "completed") {
    throw new AppError(
      409,
      "NOT_COMPLETED",
      "Only completed visits can be invoiced",
    );
  }
  const request: InvoiceRequestDoc = {
    _id: new ObjectId(),
    tenantId: auth.tenantId,
    branchId: visit.branchId,
    customerId: auth.userId,
    appointmentId: visit._id,
    status: "requested",
    amountMinor: visit.totalMinor,
    currency: visit.currency,
    receiver,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await t.invoiceRequests.insertOne(request);
  } catch (err) {
    if (isDuplicate(err)) {
      throw new AppError(
        409,
        "INVOICE_ALREADY_REQUESTED",
        "This visit already has an invoice request",
      );
    }
    throw err;
  }
  return request;
}

export const listMyInvoices = (auth: Auth) =>
  collect(
    forTenant(auth.tenantId)
      .invoiceRequests.find({ customerId: auth.userId })
      .sort({ createdAt: -1 })
      .limit(50),
  );

/** The shop's queue: owners and admins see every request, oldest first. */
export const listInvoices = (auth: Auth) =>
  collect(
    forTenant(auth.tenantId)
      .invoiceRequests.find({})
      .sort({ createdAt: 1 })
      .limit(200),
  );

export async function updateInvoice(
  auth: Auth,
  id: ObjectId,
  input: Update,
  now = new Date(),
) {
  const t = forTenant(auth.tenantId);
  const current = await t.invoiceRequests.findOne({ _id: id });
  if (!current) throw new AppError(404, "NOT_FOUND", "Not found");
  if (current.status !== "requested") {
    throw new AppError(
      409,
      "INVOICE_CLOSED",
      "This invoice is already issued or cancelled",
    );
  }
  const updated = await t.invoiceRequests.findOneAndUpdate(
    { _id: id, status: "requested" },
    {
      $set:
        input.status === "issued"
          ? {
              status: "issued",
              cfdiUuid: input.cfdiUuid,
              issuedAt: now,
              updatedAt: now,
            }
          : { status: "cancelled", updatedAt: now },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    throw new AppError(
      409,
      "INVOICE_CLOSED",
      "This invoice is already issued or cancelled",
    );
  }
  return updated;
}

export const toInvoice = (invoice: InvoiceRequestDoc) => ({
  id: invoice._id.toHexString(),
  appointmentId: invoice.appointmentId.toHexString(),
  status: invoice.status,
  amountMinor: invoice.amountMinor,
  currency: invoice.currency,
  receiver: invoice.receiver,
  ...(invoice.cfdiUuid && { cfdiUuid: invoice.cfdiUuid }),
  ...(invoice.issuedAt && { issuedAt: invoice.issuedAt }),
  createdAt: invoice.createdAt,
});
