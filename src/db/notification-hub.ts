import type { ChangeStream, ObjectId } from "mongodb";
import { type NotificationDoc, notifications } from "./collections";

type Listener = (notification: NotificationDoc) => void;

const listeners = new Map<string, Set<Listener>>();
let current:
  | { stream: ChangeStream<NotificationDoc>; ready: Promise<void> }
  | undefined;

function open() {
  const stream = notifications.watch<NotificationDoc>([
    { $match: { operationType: "insert" } },
  ]);
  stream.on("change", (change) => {
    if (change.operationType !== "insert") return;
    const doc = change.fullDocument;
    for (const listener of listeners.get(doc.userId.toHexString()) ?? []) {
      listener(doc);
    }
  });
  stream.on("error", () => {
    void stream.close();
    if (current?.stream === stream) current = undefined;
    if (listeners.size > 0) setTimeout(() => (current ??= open()), 1_000);
  });
  const ready = new Promise<void>((resolve) => {
    stream.once("resumeTokenChanged", () => resolve());
    stream.once("error", () => resolve());
    setTimeout(resolve, 5_000);
  });
  return { stream, ready };
}

export function subscribe(userId: ObjectId, listener: Listener) {
  const key = userId.toHexString();
  const forUser = listeners.get(key) ?? new Set<Listener>();
  forUser.add(listener);
  listeners.set(key, forUser);
  current ??= open();
  return {
    ready: current.ready,
    unsubscribe: () => {
      forUser.delete(listener);
      if (forUser.size === 0) listeners.delete(key);
      if (listeners.size === 0 && current) {
        void current.stream.close();
        current = undefined;
      }
    },
  };
}
