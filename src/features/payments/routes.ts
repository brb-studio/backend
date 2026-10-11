import { Hono } from "hono";
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
import { findCustomer } from "../booking/customers";
import { requireActiveSubscription } from "../tenancy/subscription";
import {
  bankSettings,
  confirmBody,
  listQuery,
  rejectBody,
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

export const paymentPublicRoutes = new Hono<Env>().post(
  "/payments/transfer",
  requireActiveSubscription,
  async (c) => {
    const ip = clientIp(c, config.PROXY_SECRET);
    if (!(await hit(`pay:${c.var.tenant._id}:${ip}`, 30, 10 * 60 * 1000))) {
      throw new AppError(429, "RATE_LIMITED", "Too many attempts");
    }
    const { appointmentId, paymentToken } = await readJson(c, transferBody);
    const auth = c.var.auth;
    // Guests prove they booked it with the token from the booking response; an id alone is guessable.
    if (!auth && !validPaymentToken(appointmentId, paymentToken)) {
      throw new AppError(404, "NOT_FOUND", "Not found");
    }
    if (auth) {
      // Signed-in users: customers only their own appointments; staff cannot pay on a customer's behalf.
      if (auth.role !== "customer") {
        throw new AppError(403, "FORBIDDEN", "Not allowed");
      }
      const t = forTenant(c.var.tenant._id);
      const [customer, appointment] = await Promise.all([
        findCustomer(t, { userId: auth.userId }),
        t.appointments.findOne({ _id: appointmentId }),
      ]);
      if (
        !appointment ||
        !customer ||
        !appointment.customerId.equals(customer._id)
      ) {
        throw new AppError(404, "NOT_FOUND", "Not found");
      }
    }
    return c.json(await createTransfer(c.var.tenant, appointmentId), 201);
  },
);

/** The barbershop's money: only owner and admin see bank details and confirm what arrived. */
export const paymentStaffRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin"))
  .get("/settings", (c) => c.json(bankSettingsOf(c.var.tenant)))
  .patch("/settings", requireActiveSubscription, async (c) =>
    c.json(
      await saveBankSettings(c.var.tenant, await readJson(c, bankSettings)),
    ),
  )
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
