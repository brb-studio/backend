import * as z from "zod";
export const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,128}\]$/;

export const MAX_NATIVE_DEVICES = 10;
export const EXPO_BATCH = 100;
export const RECEIPT_BATCH = 300;
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;
export const RECEIPT_LOOKUP_LIMIT = 1000;

export const nativeDevice = z.strictObject({
  token: z.string().regex(EXPO_TOKEN),
  platform: z.enum(["ios", "android"]),
});

export const nativeDeviceRemoval = z.strictObject({
  token: z.string().regex(EXPO_TOKEN),
});

export type NativeMessage = {
  title: string;
  body: string;
  tag: string;
  url: string;
};

const errorDetails = z.object({
  error: z.string().optional(),
});

const ticket = z.union([
  z.object({ status: z.literal("ok"), id: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: errorDetails.optional(),
  }),
]);

const receipt = z.union([
  z.object({ status: z.literal("ok") }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: errorDetails.optional(),
  }),
]);

export const sendResponse = z.object({ data: z.array(ticket) });
export const receiptsResponse = z.object({
  data: z.record(z.string(), receipt),
});

export type Ticket = z.output<typeof ticket>;
export type Receipt = z.output<typeof receipt>;

export const DEVICE_GONE = "DeviceNotRegistered";

export const isGone = (error: string | undefined) => error === DEVICE_GONE;

export const expoMessage = (token: string, message: NativeMessage) => ({
  to: token,
  title: message.title,
  body: message.body,
  sound: "default",
  priority: "high",
  data: { url: message.url, tag: message.tag },
});
