import { describe, expect, test } from "bun:test";
import {
  DEVICE_GONE,
  EXPO_TOKEN,
  expoMessage,
  isGone,
  nativeDevice,
  nativeDeviceRemoval,
  receiptsResponse,
  sendResponse,
} from "./native-rules";

const token = "ExponentPushToken[abc123_XYZ-9]";

describe("Expo token format", () => {
  test("accepts the current and the legacy Expo token formats", () => {
    expect(EXPO_TOKEN.test("ExpoPushToken[abc123_XYZ-9]")).toBe(true);
    expect(EXPO_TOKEN.test(token)).toBe(true);
  });

  test("rejects web push endpoints, empty brackets and other strings", () => {
    expect(EXPO_TOKEN.test("https://fcm.googleapis.com/fcm/send/x")).toBe(
      false,
    );
    expect(EXPO_TOKEN.test("ExponentPushToken[]")).toBe(false);
    expect(EXPO_TOKEN.test("ExponentPushToken[short]")).toBe(false);
    expect(EXPO_TOKEN.test(`${token} `)).toBe(false);
  });
});

describe("nativeDevice", () => {
  test("requires a valid token and a known platform", () => {
    expect(nativeDevice.safeParse({ token, platform: "ios" }).success).toBe(
      true,
    );
    expect(nativeDevice.safeParse({ token, platform: "web" }).success).toBe(
      false,
    );
    expect(
      nativeDevice.safeParse({ token: "nope", platform: "android" }).success,
    ).toBe(false);
  });

  test("rejects unknown keys so the contract stays strict", () => {
    expect(
      nativeDevice.safeParse({ token, platform: "ios", extra: 1 }).success,
    ).toBe(false);
  });

  test("removal accepts only the token", () => {
    expect(nativeDeviceRemoval.safeParse({ token }).success).toBe(true);
    expect(
      nativeDeviceRemoval.safeParse({ token, platform: "ios" }).success,
    ).toBe(false);
  });
});

describe("expoMessage", () => {
  test("carries only the minimal text and the route to open", () => {
    const message = expoMessage(token, {
      title: "Nueva cita · Barbería",
      body: "lun 3 nov 10:00",
      tag: "appointment-1",
      url: "/es/account",
    });
    expect(message).toEqual({
      to: token,
      title: "Nueva cita · Barbería",
      body: "lun 3 nov 10:00",
      sound: "default",
      priority: "high",
      data: { url: "/es/account", tag: "appointment-1" },
    });
  });
});

describe("Expo responses", () => {
  test("reads accepted and rejected tickets", () => {
    const parsed = sendResponse.parse({
      data: [
        { status: "ok", id: "t1" },
        { status: "error", message: "gone", details: { error: DEVICE_GONE } },
      ],
    });
    expect(parsed.data[0]).toEqual({ status: "ok", id: "t1" });
    const rejected = parsed.data[1];
    expect(
      rejected?.status === "error" && isGone(rejected.details?.error),
    ).toBe(true);
  });

  test("reads receipts keyed by ticket id", () => {
    const parsed = receiptsResponse.parse({
      data: {
        t1: { status: "ok" },
        t2: {
          status: "error",
          message: "gone",
          details: { error: DEVICE_GONE },
        },
      },
    });
    expect(parsed.data.t1).toEqual({ status: "ok" });
    expect(parsed.data.t2?.status).toBe("error");
  });

  test("a malformed response breaks the contract instead of passing silently", () => {
    expect(() => sendResponse.parse({ data: [{ status: "ok" }] })).toThrow();
  });

  test("only DeviceNotRegistered means the token must be removed", () => {
    expect(isGone(DEVICE_GONE)).toBe(true);
    expect(isGone("MessageRateExceeded")).toBe(false);
    expect(isGone(undefined)).toBe(false);
  });
});
