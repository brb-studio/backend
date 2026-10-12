import { expect } from "bun:test";
import { ObjectId } from "mongodb";
import { appointments, payments } from "../src/db/collections";
import { api, dayIn, guestBooking, instantIn, type Shop } from "./helpers";
import { type FakeStripe, intentEvent, sendEvent } from "./stripe-fake";

export type Booked = {
  id: string;
  status: string;
  paymentToken: string;
  checkout: {
    paymentId: string;
    kind: string;
    status: string;
    amountMinor: number;
    balanceMinor: number;
    refundableMinor: number;
    clientSecret?: string;
    transfer?: { clabe: string; amountRemainingMinor: number };
  };
};

export const DEPOSIT = { enabled: true, percentBps: 2_500 };

export const at = (shop: Shop, days: number, time: string) =>
  instantIn(shop.timeZone, dayIn(shop.timeZone, days), time);

/** Booking, paying and expiring online payments against the fake Stripe the test is using. */
export function paymentFlow(current: () => FakeStripe) {
  async function book(
    shop: Shop,
    startAt: string,
    payment: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const res = await api("POST", "/v1/public/appointments", {
      host: shop.host,
      body: guestBooking(startAt, { payment, ...extra }),
    });
    if (res.status !== 201)
      throw new Error(`book: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as unknown as Booked;
  }

  const intentOf = async (booked: Booked) => {
    const payment = await payments.findOne({
      _id: new ObjectId(booked.checkout.paymentId),
    });
    return current().intent(String(payment?.stripe?.paymentIntentId));
  };

  const status = (shop: Shop, booked: Booked) =>
    api(
      "GET",
      `/v1/public/appointments/${booked.id}/payment?paymentToken=${booked.paymentToken}`,
      { host: shop.host },
    );

  const appointmentOf = (booked: Booked) =>
    appointments.findOne({ _id: new ObjectId(booked.id) });

  async function pay(booked: Booked, type = "payment_intent.succeeded") {
    const pi = current().succeed((await intentOf(booked)).id);
    const res = await sendEvent(intentEvent(type, pi));
    expect(res.status).toBe(200);
    return pi;
  }

  const expire = (booked: Booked) =>
    appointments.updateOne(
      { _id: new ObjectId(booked.id) },
      { $set: { paymentDeadline: new Date(Date.now() - 1_000) } },
    );

  return { book, intentOf, status, appointmentOf, pay, expire };
}
