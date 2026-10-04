import type { Hours } from "../../db/scoped";

export type Interval = { start: number; end: number };

export type EngineInput = {
  timeZone: string;
  slotIntervalMin: number;
  bufferMin: number;
  branchHours: Hours[];
  barberHours: Hours[];
  blocks: Interval[];
  busy: Interval[];
  durationMin: number;
  earliest: number;
};

export type Slot = { startAt: Date; time: string };
export type Day = { date: string; slots: Slot[] };

const toMinutes = (hhmm: string) =>
  Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const overlaps = (start: number, end: number, list: Interval[]) =>
  list.some((i) => start < i.end && end > i.start);

function intersect(a: [number, number][], b: [number, number][]) {
  const out: [number, number][] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const start = Math.max(a0, b0);
      const end = Math.min(a1, b1);
      if (start < end) out.push([start, end]);
    }
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function instantAt(
  date: Temporal.PlainDate,
  minutes: number,
  timeZone: string,
) {
  try {
    return date
      .toPlainDateTime({ hour: Math.floor(minutes / 60), minute: minutes % 60 })
      .toZonedDateTime(timeZone, { disambiguation: "reject" })
      .epochMilliseconds;
  } catch {
    return null;
  }
}

export const localDate = (at: Date | number, timeZone: string) =>
  Temporal.Instant.fromEpochMilliseconds(Number(at))
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();

export const startOfDay = (date: string, timeZone: string) =>
  Temporal.PlainDate.from(date).toZonedDateTime(timeZone).epochMilliseconds;

export function freeSlots(input: EngineInput, dates: string[]): Day[] {
  const durationMs = input.durationMin * 60_000;
  const bufferMs = input.bufferMin * 60_000;
  return dates
    .map((date) => {
      const day = Temporal.PlainDate.from(date);
      const weekday = day.dayOfWeek % 7;
      const windows = (hours: Hours[]) =>
        hours
          .filter((h) => h.weekday === weekday)
          .map((h): [number, number] => [
            toMinutes(h.open),
            toMinutes(h.close),
          ]);
      const slots: Slot[] = [];
      for (const [open, close] of intersect(
        windows(input.branchHours),
        windows(input.barberHours),
      )) {
        const first = instantAt(day, open, input.timeZone);
        const last = instantAt(day, close, input.timeZone);
        const linear =
          first !== null &&
          last !== null &&
          last - first === (close - open) * 60_000;
        for (
          let minute = open;
          minute + input.durationMin <= close;
          minute += input.slotIntervalMin
        ) {
          const start = linear
            ? first + (minute - open) * 60_000
            : instantAt(day, minute, input.timeZone);
          if (start === null || start < input.earliest) continue;
          const end = start + durationMs;
          if (overlaps(start, end, input.blocks)) continue;
          if (overlaps(start, end + bufferMs, input.busy)) continue;
          slots.push({ startAt: new Date(start), time: toHHMM(minute) });
        }
      }
      return { date, slots };
    })
    .filter((day) => day.slots.length > 0);
}

export function isBookable(input: EngineInput, startAt: Date) {
  const [day] = freeSlots(input, [localDate(startAt, input.timeZone)]);
  return !!day?.slots.some((s) => s.startAt.getTime() === startAt.getTime());
}
