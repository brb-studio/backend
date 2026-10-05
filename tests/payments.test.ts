import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { config } from "../src/config";
import { requireStripe } from "../src/features/payments/stripe";
import {
  api,
  bookingShop,
  dayIn,
  guestBooking,
  instantIn,
  type Shop,
} from "./helpers";

/** Payments on for this file only (booking.test.ts relies on them being off). */
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: "whsec_fake",
  STRIPE_PUBLISHABLE_KEY: "pk_test_fake",
} as const;
const saved: Partial<typeof config> = {};
beforeAll(() => {
  for (const key of Object.keys(STRIPE_ENV) as (keyof typeof STRIPE_ENV)[]) {
    saved[key] = config[key];
    config[key] = STRIPE_ENV[key];
  }
});
afterAll(() => Object.assign(config, saved));

let restore: (() => void) | undefined;
beforeEach(() => {
  let seq = 0;
  const spy = spyOn(
    requireStripe().paymentIntents,
    "create",
  ).mockImplementation((async (params: { amount: number }) => ({
    id: `pi_test${++seq}`,
    client_secret: `pi_test${seq}_secret_x`,
    amount: params.amount,
  })) as never);
  restore = () => spy.mockRestore();
});
afterEach(() => restore?.());

const connectedShop = () =>
  bookingShop({
    tenant: {
      stripe: {
        accountId: `acct_${crypto.randomUUID().replaceAll("-", "")}`,
        detailsSubmitted: true,
        chargesEnabled: true,
      },
    },
  });

async function bookAsGuest(shop: Shop, days: number) {
  const startAt = instantIn(shop.timeZone, dayIn(shop.timeZone, days), "11:00");
  const res = await api("POST", "/v1/public/appointments", {
    host: shop.host,
    body: guestBooking(startAt),
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; paymentToken?: string };
}

const intent = (shop: Shop, body: Record<string, unknown>) =>
  api("POST", "/v1/public/payments/intent", { host: shop.host, body });

describe("paying a booking as a guest", () => {
  test("needs the token from the booking response; the id alone is not enough", async () => {
    const shop = await connectedShop();
    const mine = await bookAsGuest(shop, 2);
    const theirs = await bookAsGuest(shop, 3);
    expect(mine.paymentToken).toMatch(/^[\w-]{43}$/);

    expect((await intent(shop, { appointmentId: theirs.id })).status).toBe(404);
    const borrowed = await intent(shop, {
      appointmentId: theirs.id,
      paymentToken: mine.paymentToken,
    });
    expect(borrowed.status).toBe(404);
    expect(
      (
        await intent(shop, {
          appointmentId: mine.id,
          paymentToken: "x".repeat(43),
        })
      ).status,
    ).toBe(404);

    const ok = await intent(shop, {
      appointmentId: mine.id,
      paymentToken: mine.paymentToken,
    });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({
      appointmentId: mine.id,
      amountMinor: 30_000,
      publishableKey: "pk_test_fake",
    });
  });
});
