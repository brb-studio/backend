import { Hono } from "hono";
import { type Env, parseId, readJson } from "../../shared/http";
import { authOf, requireRole } from "../auth/routes";
import { requireActiveSubscription } from "../tenancy/subscription";
import { invoiceReceiver, invoiceUpdate } from "./schemas";
import {
  listInvoices,
  listMyInvoices,
  requestInvoice,
  toInvoice,
  updateInvoice,
} from "./service";

export const invoiceRoutes = new Hono<Env>()
  .use(requireRole("owner", "admin"))
  .get("/", async (c) => c.json((await listInvoices(authOf(c))).map(toInvoice)))
  .patch("/:id", requireActiveSubscription, async (c) => {
    const id = parseId(c.req.param("id"));
    const input = await readJson(c, invoiceUpdate);
    return c.json(toInvoice(await updateInvoice(authOf(c), id, input)));
  });

export const myInvoiceRoutes = new Hono<Env>()
  .post(
    "/appointments/:id/invoice",
    requireRole("customer"),
    requireActiveSubscription,
    async (c) => {
      const id = parseId(c.req.param("id"));
      const receiver = await readJson(c, invoiceReceiver);
      const request = await requestInvoice(
        c.var.tenant,
        authOf(c),
        id,
        receiver,
      );
      return c.json(toInvoice(request), 201);
    },
  )
  .get("/invoices", requireRole("customer"), async (c) =>
    c.json((await listMyInvoices(authOf(c))).map(toInvoice)),
  );
