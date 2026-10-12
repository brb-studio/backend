import { describe, expect, test } from "bun:test";
import { signPayload, TOLERANCE_SECONDS, verifySignature } from "./signature";

const body = '{"id":"evt_1","object":"event"}';
const secret = "whsec_test_secret";
const now = 1_760_000_000;
const header = (t: number, sig = signPayload(body, secret, t)) =>
  `t=${t},v1=${sig}`;

describe("verifySignature", () => {
  test("accepts a fresh signature from any configured secret", () => {
    expect(verifySignature(body, header(now), [secret], now)).toBe(true);
    expect(
      verifySignature(body, header(now), ["whsec_other", secret], now),
    ).toBe(true);
  });

  test("accepts the header when one of several v1 signatures matches", () => {
    const wrong = "0".repeat(64);
    const value = `t=${now},v1=${wrong},v1=${signPayload(body, secret, now)}`;
    expect(verifySignature(body, value, [secret], now)).toBe(true);
  });

  test("refuses a changed body, a wrong secret or a missing header", () => {
    expect(verifySignature(`${body} `, header(now), [secret], now)).toBe(false);
    expect(verifySignature(body, header(now), ["whsec_other"], now)).toBe(
      false,
    );
    expect(verifySignature(body, undefined, [secret], now)).toBe(false);
    expect(verifySignature(body, "garbage", [secret], now)).toBe(false);
    expect(verifySignature(body, `t=${now}`, [secret], now)).toBe(false);
  });

  test("refuses replays outside the tolerance", () => {
    const old = now - TOLERANCE_SECONDS - 1;
    expect(verifySignature(body, header(old), [secret], now)).toBe(false);
    const edge = now - TOLERANCE_SECONDS;
    expect(verifySignature(body, header(edge), [secret], now)).toBe(true);
  });
});
