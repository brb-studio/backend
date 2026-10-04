import { Hono } from "hono";
import { config } from "../../config";
import {
  clientIp,
  type Env,
  parse,
  parseId,
  readJson,
} from "../../shared/http";
import { STAFF } from "../auth/policy";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import {
  appointmentRange,
  appointmentUpdate,
  publicBooking,
  publicQuote,
  staffBooking,
} from "./schemas";
import {
  bookAsStaff,
  bookOnline,
  cancelMine,
  getAppointment,
  listAppointments,
  listMine,
  quote,
  updateAppointment,
} from "./service";

export const publicBookingRoutes = new Hono<Env>()
  .post("/appointments", requireActiveSubscription, async (c) => {
    const input = await readJson(c, publicBooking);
    const ip = clientIp(c, config.PROXY_SECRET);
    return c.json(await bookOnline(c.var.tenant, c.var.auth, input, ip), 201);
  })
  .post("/quote", async (c) => {
    const input = await readJson(c, publicQuote);
    const ip = clientIp(c, config.PROXY_SECRET);
    return c.json(await quote(c.var.tenant, c.var.auth, input, ip));
  });

export const meRoutes = new Hono<Env>()
  .use(requireRole("customer"))
  .get("/appointments", async (c) =>
    c.json(await listMine(c.var.tenant, authOf(c))),
  )
  .post("/appointments/:id/cancel", async (c) => {
    await cancelMine(c.var.tenant, authOf(c), parseId(c.req.param("id")));
    return c.body(null, 204);
  });

export const appointmentRoutes = new Hono<Env>()
  .use(requireRole(...STAFF))
  .get("/", async (c) =>
    c.json(
      await listAppointments(authOf(c), parse(appointmentRange, c.req.query())),
    ),
  )
  .get("/:id", async (c) =>
    c.json(await getAppointment(authOf(c), parseId(c.req.param("id")))),
  )
  .post("/", requireActiveSubscription, async (c) => {
    const input = await readJson(c, staffBooking);
    return c.json(await bookAsStaff(c.var.tenant, authOf(c), input), 201);
  })
  .patch("/:id", requireActiveSubscription, async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await readJson(c, appointmentUpdate);
    return c.json(await updateAppointment(c.var.tenant, authOf(c), id, input));
  });
