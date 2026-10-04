import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";

export type PushTarget = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

const fromB64 = (value: string) => Buffer.from(value, "base64url");
const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const hmac = (key: Uint8Array, data: Uint8Array) =>
  createHmac("sha256", key).update(data).digest();

const PUSH_HOSTS =
  /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;

export function isPushEndpoint(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      PUSH_HOSTS.test(url.hostname)
    );
  } catch {
    return false;
  }
}

export function generateVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const d = ecdh.getPrivateKey();
  return {
    publicKey: toB64(ecdh.getPublicKey()),
    privateKey: toB64(Buffer.concat([Buffer.alloc(32 - d.length), d])),
  };
}

export function encryptPayload(
  payload: Uint8Array,
  keys: PushTarget["keys"],
  fixed?: { salt: Uint8Array; privateKey: Uint8Array },
) {
  const browserKey = fromB64(keys.p256dh);
  const authSecret = fromB64(keys.auth);
  const ecdh = createECDH("prime256v1");
  if (fixed) ecdh.setPrivateKey(fixed.privateKey);
  else ecdh.generateKeys();
  const serverKey = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(browserKey);

  const prkKey = hmac(authSecret, secret);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    browserKey,
    serverKey,
  ]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const salt = fixed ? Buffer.from(fixed.salt) : randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(
    prk,
    Buffer.from("Content-Encoding: aes128gcm\0\x01"),
  ).subarray(0, 16);
  const nonce = hmac(
    prk,
    Buffer.from("Content-Encoding: nonce\0\x01"),
  ).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverKey.length, 20);
  return Buffer.concat([header, serverKey, sealed]);
}

export function vapidAuthorization(
  endpoint: string,
  vapid: VapidKeys,
  now = Date.now(),
) {
  const point = fromB64(vapid.publicKey);
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: vapid.privateKey,
      x: toB64(point.subarray(1, 33)),
      y: toB64(point.subarray(33, 65)),
    },
    format: "jwk",
  });
  const encode = (value: object) => toB64(Buffer.from(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${toB64(signature)}, k=${vapid.publicKey}`;
}

export async function sendPush(
  target: PushTarget,
  message: object,
  vapid: VapidKeys,
) {
  const response = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      TTL: String(24 * 60 * 60),
      Urgency: "high",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: vapidAuthorization(target.endpoint, vapid),
    },
    body: encryptPayload(Buffer.from(JSON.stringify(message)), target.keys),
    signal: AbortSignal.timeout(10_000),
  });
  return response.status;
}
