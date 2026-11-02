import { ObjectId } from "mongodb";
import type * as z from "zod";
import { config } from "../../config";
import { forTenant, platform } from "../../db/scoped";
import { collect } from "../../shared/cursor";
import type { Auth } from "../../shared/http";
import {
  EXPO_BATCH,
  expoMessage,
  isGone,
  MAX_NATIVE_DEVICES,
  type NativeMessage,
  type nativeDevice,
  RECEIPT_BATCH,
  RECEIPT_DELAY_MS,
  RECEIPT_LOOKUP_LIMIT,
  type Receipt,
  receiptsResponse,
  sendResponse,
  type Ticket,
} from "./native-rules";

export {
  type NativeMessage,
  nativeDevice,
  nativeDeviceRemoval,
} from "./native-rules";

function headers(): Record<string, string> {
  const base: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (config.EXPO_ACCESS_TOKEN)
    base.Authorization = `Bearer ${config.EXPO_ACCESS_TOKEN}`;
  return base;
}

async function expoPost<T extends z.ZodType>(
  base: string,
  path: string,
  body: unknown,
  schema: T,
): Promise<z.output<T>> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`expo push answered ${response.status}`);
  return schema.parse(await response.json());
}

export const sendToExpo = async (
  messages: ReturnType<typeof expoMessage>[],
  base = config.EXPO_PUSH_API_URL,
): Promise<Ticket[]> =>
  (await expoPost(base, "/send", messages, sendResponse)).data;

export const receiptsFromExpo = async (
  ids: string[],
  base = config.EXPO_PUSH_API_URL,
): Promise<Record<string, Receipt>> =>
  (await expoPost(base, "/getReceipts", { ids }, receiptsResponse)).data;

export async function subscribeNative(
  auth: Auth,
  input: z.output<typeof nativeDevice>,
) {
  const now = new Date();
  await platform.nativePushDevices.updateOne(
    { token: input.token },
    {
      $set: {
        tenantId: auth.tenantId,
        userId: auth.userId,
        platform: input.platform,
        lastSeenAt: now,
        updatedAt: now,
      },
      $setOnInsert: { _id: new ObjectId(), createdAt: now },
    },
    { upsert: true },
  );
  await keepNewestDevices(auth);
}

async function keepNewestDevices(auth: Auth) {
  const t = forTenant(auth.tenantId);
  const devices = await collect(
    t.nativePushDevices
      .find({ userId: auth.userId })
      .sort({ lastSeenAt: -1 })
      .project<{ _id: ObjectId }>({ _id: 1 }),
  );
  const stale = devices.slice(MAX_NATIVE_DEVICES).map((d) => d._id);
  if (stale.length > 0) {
    await t.nativePushDevices.deleteMany({ _id: { $in: stale } });
  }
}

export async function unsubscribeNative(auth: Auth, token: string) {
  await forTenant(auth.tenantId).nativePushDevices.deleteOne({
    userId: auth.userId,
    token,
  });
}

export async function deliverNative(
  tenantId: ObjectId,
  items: { userId: ObjectId; message: NativeMessage }[],
) {
  if (items.length === 0) return;
  const t = forTenant(tenantId);
  const devices = await collect(
    t.nativePushDevices
      .find({ userId: { $in: items.map((i) => i.userId) } })
      .project<{ userId: ObjectId; token: string }>({ userId: 1, token: 1 }),
  );
  const jobs = items.flatMap(({ userId, message }) =>
    devices
      .filter((d) => d.userId.equals(userId))
      .map((device) => ({ token: device.token, message })),
  );
  for (let i = 0; i < jobs.length; i += EXPO_BATCH) {
    const chunk = jobs.slice(i, i + EXPO_BATCH);
    try {
      const tickets = await sendToExpo(
        chunk.map(({ token, message }) => expoMessage(token, message)),
      );
      await handleTickets(
        tenantId,
        chunk.map((j) => j.token),
        tickets,
      );
    } catch (err) {
      logPush("native_push_failed", err);
    }
  }
}

async function handleTickets(
  tenantId: ObjectId,
  tokens: string[],
  tickets: Ticket[],
) {
  const now = new Date();
  const accepted: {
    _id: ObjectId;
    tenantId: ObjectId;
    token: string;
    ticketId: string;
    createdAt: Date;
  }[] = [];
  for (const [index, result] of tickets.entries()) {
    const token = tokens[index];
    if (!token) continue;
    if (result.status === "ok") {
      accepted.push({
        _id: new ObjectId(),
        tenantId,
        token,
        ticketId: result.id,
        createdAt: now,
      });
    } else if (isGone(result.details?.error)) {
      await platform.nativePushDevices.deleteOne({ token });
    } else {
      logPush("native_push_rejected", result.message);
    }
  }
  if (accepted.length > 0) await platform.pushReceipts.insertMany(accepted);
}

/** Checks accepted tickets older than the delay; removes tokens Expo reports as gone. */
export async function checkNativeReceipts(now = new Date()) {
  const due = await collect(
    platform.pushReceipts
      .find({
        createdAt: { $lte: new Date(now.getTime() - RECEIPT_DELAY_MS) },
      })
      .limit(RECEIPT_LOOKUP_LIMIT),
  );
  const finished: ObjectId[] = [];
  for (let i = 0; i < due.length; i += RECEIPT_BATCH) {
    const batch = due.slice(i, i + RECEIPT_BATCH);
    try {
      const receipts = await receiptsFromExpo(batch.map((d) => d.ticketId));
      for (const item of batch) {
        const result = receipts[item.ticketId];
        if (!result) continue;
        finished.push(item._id);
        if (result.status === "error") {
          if (isGone(result.details?.error)) {
            await platform.nativePushDevices.deleteOne({ token: item.token });
          } else {
            logPush("native_push_receipt_error", result.message);
          }
        }
      }
    } catch (err) {
      logPush("native_receipts_failed", err);
    }
  }
  if (finished.length > 0) {
    await platform.pushReceipts.deleteMany({ _id: { $in: finished } });
  }
}

function logPush(event: string, error: unknown) {
  console.error(
    JSON.stringify({ level: "error", event, message: String(error) }),
  );
}
