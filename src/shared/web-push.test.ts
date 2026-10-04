import { describe, expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import {
  encryptPayload,
  generateVapidKeys,
  isPushEndpoint,
  vapidAuthorization,
} from "./web-push";

describe("encryptPayload", () => {
  test("matches the RFC 8291 test vector byte for byte", () => {
    const body = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      {
        salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"),
        privateKey: Buffer.from(
          "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
          "base64url",
        ),
      },
    );
    expect(body.toString("base64url")).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  test("a fresh salt and key every time", () => {
    const keys = {
      p256dh:
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
      auth: "BTBZMqHH6r4Tts7J_aSIgg",
    };
    const a = encryptPayload(Buffer.from("hola"), keys);
    const b = encryptPayload(Buffer.from("hola"), keys);
    expect(a.equals(b)).toBe(false);
  });
});

describe("vapidAuthorization", () => {
  test("an ES256 JWT for the endpoint's origin, verifiable with the public key", () => {
    const keys = {
      ...generateVapidKeys(),
      subject: "mailto:ops@magicstudio.test",
    };
    const now = Date.parse("2026-10-03T12:00:00Z");
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      keys,
      now,
    );
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
      header,
    );
    if (!match) throw new Error(`bad header: ${header}`);
    const [, head = "", claims = "", signature = "", k = ""] = match;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: now / 1000 + 12 * 60 * 60,
      sub: "mailto:ops@magicstudio.test",
    });
    const point = Buffer.from(keys.publicKey, "base64url");
    const publicKey = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33, 65).toString("base64url"),
      },
      format: "jwk",
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });
});

test("only real push services are accepted as endpoints", () => {
  for (const ok of [
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://web.push.apple.com/QGr-abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ]) {
    expect(isPushEndpoint(ok)).toBe(true);
  }
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://127.0.0.1/push",
    "https://fcm.googleapis.com.evil.com/x",
    "https://fcm.googleapis.com:8443/x",
    "https://localhost/x",
    "not a url",
  ]) {
    expect(isPushEndpoint(bad)).toBe(false);
  }
});
