const HOUR = 60 * 60 * 1000;
/** Closest first: when several are due, only the nearest one is sent. */
const REMINDERS = [
  { key: "h2", beforeMs: 2 * HOUR },
  { key: "h24", beforeMs: 24 * HOUR },
] as const;

export type ReminderKey = (typeof REMINDERS)[number]["key"];
export const REMINDER_HORIZON_MS = 24 * HOUR;

export function dueReminder(
  appointment: { startAt: Date; createdAt: Date },
  now: Date,
): ReminderKey | undefined {
  if (now >= appointment.startAt) return undefined;
  for (const { key, beforeMs } of REMINDERS) {
    const moment = appointment.startAt.getTime() - beforeMs;
    if (now.getTime() >= moment && appointment.createdAt.getTime() <= moment) {
      return key;
    }
  }
  return undefined;
}
