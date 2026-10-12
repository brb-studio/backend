import { type Context, Hono } from "hono";
import type { ObjectId } from "mongodb";
import { config } from "../../config";
import { hit } from "../../db/rate-limit";
import { forTenant } from "../../db/scoped";
import {
  AppError,
  clientIp,
  type Env,
  parse,
  parseId,
  readJson,
} from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { getUser } from "../auth/service";
import { findCustomer } from "../booking/customers";
import { requireActiveSubscription } from "../tenancy/subscription";
import { checkoutStatus, refundAppointment, switchPayment } from "./checkout";
import {
  connectView,
  dashboardLink,
  onboardingUrls,
  refreshAccount,
  saveDeposit,
  startOnboarding,
} from "./connect";
import {
  bankSettings,
  checkoutQuery,
  confirmBody,
  depositBody,
  listQuery,
  onboardingBody,
  refundBody,
  rejectBody,
  switchBody,
  transferBody,
} from "./schemas";
import {
  bankSettingsOf,
  confirmPayment,
  createTransfer,
  listPayments,
  rejectPayment,
  saveBankSettings,
} from "./service";
import { validPaymentToken } from "./token";

const notFound = () => new AppError(404, "NOT_FOUND", "Not found");

async function limit(c: Context<Env>) {
  const ip = clientIp(c, config.PROXY_SECRET);
  if (!(await hit(`pay:${c.var.tenant._id}:${ip}`, 30, 10 * 60 * 1000))) {
    throw new AppError(429, "RATE_LIMITED", "Too many attempts");
  }
}

/**
 * Only whoever booked pays: guests prove it with the token from the booking response (an id alone is
 * guessable), customers only for their own appointments, and staff never on a customer's behalf.
 */
async function assertPayer(
  c: Context<Env>,
  appointmentId: ObjectId,
  paymentToken: string | undefined,
) {
  const auth = c.var.auth;
  if (!auth) {
    if (!validPaymentToken(appointmentId, paymentToken)) throw notFound();
    return;
  }
  if (auth.role !== "customer") {
    throw new AppError(403, "FORBIDDEN", "Not allowed");
  }
  const t = forTenant(c.var.tenant._id);
  const [customer, appointment] = await Promise.all([
    findCustomer(t, { userId: auth.userId }),
    t.appointments.findOne({ _id: appointmentId }),
  ]);
  if (!appointment || !customer?._id.equals(appointment.customerId)) {
    throw notFound();
  }
}

export const paymentPublicRoutes = new Hono<Env>()
  .post("/payments/transfer", requireActiveSubscription, async (c) => {
    await limit(c);
    const { appointmentId, paymentToken } = await readJson(c, transferBody);
    await assertPayer(c, appointmentId, paymentToken);
    return c.json(await createTransfer(c.var.tenant, appointmentId), 201);
  })
  /** The payment screen polls this until the webhook settles the payment. */
  .get("/appointments/:id/payment", async (c) => {
    const id = parseId(c.req.param("id"));
    const { paymentToken, secret } = parse(checkoutQuery, c.req.query());
    await assertPayer(c, id, paymentToken);
    return c.json(await checkoutStatus(c.var.tenant, id, secret === "1"));
  })
  .post("/appointments/:id/payment", requireActiveSubscription, async (c) => {
    await limit(c);
    const id = parseId(c.req.param("id"));
    const { paymentToken, ...choice } = await readJson(c, switchBody);
    await assertPayer(c, id, paymentToken);
    return c.json(await switchPayment(c.var.tenant, id, choice), 201);
  });

/** Where Stripe sends the owner back: the barbershop's own site (the host this request came for). */
function tenantOrigin(c: Context<Env>) {
  const host =
    c.req.header("X-Tenant-Host") ??
    c.req.header("X-Forwarded-Host") ??
    c.req.header("Host") ??
    "";
  const local = /(^|\.)localhost(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}

/** The barbershop's money: only owner and admin see bank details, connect Stripe and refund. */
export const paymentStaffRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin"))
  .get("/settings", (c) => c.json(bankSettingsOf(c.var.tenant)))
  .patch("/settings", requireActiveSubscription, async (c) =>
    c.json(
      await saveBankSettings(c.var.tenant, await readJson(c, bankSettings)),
    ),
  )
  .get("/stripe", (c) => c.json(connectView(c.var.tenant)))
  .post("/stripe/onboarding", requireActiveSubscription, async (c) => {
    const { locale } = await readJson(c, onboardingBody);
    const tenant = c.var.tenant;
    const user = await getUser(authOf(c));
    const urls = onboardingUrls(
      tenantOrigin(c),
      locale ?? tenant.defaultLocale,
    );
    return c.json(await startOnboarding(tenant, user.email, urls));
  })
  .post("/stripe/refresh", async (c) =>
    c.json(await refreshAccount(c.var.tenant)),
  )
  .post("/stripe/dashboard", async (c) =>
    c.json(await dashboardLink(c.var.tenant)),
  )
  .patch("/deposit", requireActiveSubscription, async (c) =>
    c.json(await saveDeposit(c.var.tenant, await readJson(c, depositBody))),
  )
  .post("/appointments/:id/refund", requireActiveSubscription, async (c) => {
    const { amountMinor } = await readJson(c, refundBody);
    return c.json(
      await refundAppointment(
        c.var.tenant,
        parseId(c.req.param("id")),
        authOf(c).userId,
        amountMinor,
      ),
    );
  })
  .get("/", async (c) => {
    const { status } = parse(listQuery, c.req.query());
    return c.json(await listPayments(c.var.tenant, status));
  })
  .post("/:id/confirm", requireActiveSubscription, async (c) => {
    const input = await readJson(c, confirmBody);
    return c.json(
      await confirmPayment(
        c.var.tenant,
        authOf(c).userId,
        parseId(c.req.param("id")),
        input,
      ),
    );
  })
  .post("/:id/reject", requireActiveSubscription, async (c) => {
    const input = await readJson(c, rejectBody);
    return c.json(
      await rejectPayment(
        c.var.tenant,
        authOf(c).userId,
        parseId(c.req.param("id")),
        input,
      ),
    );
  });
