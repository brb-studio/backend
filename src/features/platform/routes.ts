import { type Context, Hono } from "hono";
import { requestId } from "hono/request-id";
import { config } from "../../config";
import { hit } from "../../db/rate-limit";
import {
  AppError,
  clientIp,
  type Env,
  parse,
  parseId,
  readJson,
} from "../../shared/http";
import {
  bearerOf,
  getStaff,
  platformLogin,
  platformLogout,
  requirePlatformStaff,
  toStaff,
} from "./auth";
import { createPayout, setCommissionRate } from "./payouts";
import {
  appointmentDetail,
  breakdown,
  listAppointments,
  options,
  summary,
} from "./queries";
import {
  breakdownQuery,
  commissionUpdate,
  filters,
  platformLogin as loginBody,
  optionsQuery,
  paging,
  payoutCreate,
} from "./schemas";

const LOGIN_IPS = 30;

const staffId = (c: Context<Env>) => {
  const id = c.var.platformStaffId;
  if (!id) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  return id;
};

/**
 * Global staff dashboard API. Outside /v1 on purpose: it spans every barbershop, so no tenant is resolved
 * from the host and tenant sessions don't work here. Only platform staff (own accounts, own sessions) pass.
 */
export const platformRoutes = new Hono<Env>()
  .use(requestId())
  .post("/auth/login", async (c) => {
    const ip = clientIp(c, config.PROXY_SECRET);
    if (!(await hit(`platform-login-ip:${ip}`, LOGIN_IPS, 15 * 60 * 1000))) {
      throw new AppError(
        429,
        "RATE_LIMITED",
        "Too many attempts, try again later",
      );
    }
    const { email, password } = await readJson(c, loginBody);
    const { token, expiresAt, staff } = await platformLogin(email, password);
    return c.json({ token, expiresAt, staff: toStaff(staff) });
  })
  .use(requirePlatformStaff)
  .get("/auth/me", async (c) =>
    c.json({ staff: toStaff(await getStaff(staffId(c))) }),
  )
  .post("/auth/logout", async (c) => {
    await platformLogout(bearerOf(c.req.header("Authorization")) ?? "");
    return c.body(null, 204);
  })
  .get("/options", async (c) =>
    c.json(await options(parse(optionsQuery, c.req.query()))),
  )
  .get("/summary", async (c) =>
    c.json(await summary(parse(filters, c.req.query()))),
  )
  .get("/breakdown", async (c) => {
    const { by } = parse(breakdownQuery, c.req.query());
    return c.json(
      await breakdown(
        by,
        parse(filters, c.req.query()),
        parse(paging, c.req.query()),
      ),
    );
  })
  .get("/appointments", async (c) =>
    c.json(
      await listAppointments(
        parse(filters, c.req.query()),
        parse(paging, c.req.query()),
      ),
    ),
  )
  .get("/appointments/:id", async (c) =>
    c.json(await appointmentDetail(parseId(c.req.param("id")))),
  )
  .patch("/barbers/:id/commission", async (c) => {
    const { commissionBps } = await readJson(c, commissionUpdate);
    await setCommissionRate(parseId(c.req.param("id")), commissionBps);
    return c.body(null, 204);
  })
  .post("/payouts", async (c) => {
    const input = await readJson(c, payoutCreate);
    return c.json(await createPayout(staffId(c), input), 201);
  });
