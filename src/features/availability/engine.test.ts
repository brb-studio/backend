import { describe, expect, test } from "bun:test";
import { type EngineInput, freeSlots, isBookable, localDate } from "./engine";

const TJ = "America/Tijuana";
const MONDAY = "2026-10-05";
const at = (local: string, timeZone = TJ) =>
  Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone)
    .epochMilliseconds;
const allWeek = (open: string, close: string) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, open, close }));

const base: EngineInput = {
  timeZone: TJ,
  slotIntervalMin: 15,
  bufferMin: 0,
  branchHours: allWeek("09:00", "20:00"),
  barberHours: allWeek("10:00", "18:00"),
  blocks: [],
  busy: [],
  durationMin: 45,
  earliest: 0,
};
const times = (input: Partial<EngineInput>, date = MONDAY) =>
  freeSlots({ ...base, ...input }, [date])[0]?.slots.map((s) => s.time) ?? [];

describe("freeSlots", () => {
  test("respects both the branch's and the barber's hours", () => {
    const list = times({});
    expect(list[0]).toBe("10:00");
    expect(list.at(-1)).toBe("17:15");
  });

  test("never overlaps an existing appointment (12:00–12:45)", () => {
    const list = times({
      busy: [{ start: at(`${MONDAY}T12:00`), end: at(`${MONDAY}T12:45`) }],
    });
    expect(list).toContain("11:15");
    for (const t of ["11:30", "11:45", "12:00", "12:15", "12:30"])
      expect(list).not.toContain(t);
    expect(list).toContain("12:45");
  });

  test("keeps the buffer clear after every appointment", () => {
    const list = times({
      bufferMin: 10,
      busy: [{ start: at(`${MONDAY}T12:00`), end: at(`${MONDAY}T12:55`) }],
    });
    expect(list).toContain("11:00");
    expect(list).not.toContain("11:15");
    expect(list).not.toContain("12:45");
    expect(list).toContain("13:00");
  });

  test("blocks time off", () => {
    const list = times({
      blocks: [{ start: at(`${MONDAY}T14:00`), end: at(`${MONDAY}T15:00`) }],
    });
    expect(list).toContain("13:15");
    expect(list).not.toContain("13:30");
    expect(list).not.toContain("14:45");
    expect(list).toContain("15:00");
  });

  test("a whole-day closure leaves the day out", () => {
    expect(
      freeSlots(
        {
          ...base,
          blocks: [
            { start: at(`${MONDAY}T00:00`), end: at("2026-10-06T00:00") },
          ],
        },
        [MONDAY],
      ),
    ).toEqual([]);
  });

  test("durations of 30, 45 and 90 minutes and a 105-minute package all fit the hours", () => {
    expect(times({ durationMin: 30 }).at(-1)).toBe("17:30");
    expect(times({ durationMin: 45 }).at(-1)).toBe("17:15");
    expect(times({ durationMin: 90 }).at(-1)).toBe("16:30");
    expect(times({ durationMin: 105 }).at(-1)).toBe("16:15");
  });

  test("a split shift leaves its break free", () => {
    const list = times({
      barberHours: [
        { weekday: 1, open: "10:00", close: "14:00" },
        { weekday: 1, open: "15:00", close: "18:00" },
      ],
    });
    expect(list).toContain("13:15");
    expect(list).not.toContain("13:30");
    expect(list).not.toContain("14:30");
    expect(list).toContain("15:00");
  });

  test("closed weekdays and slots before `earliest` are skipped", () => {
    expect(
      times({ barberHours: [{ weekday: 2, open: "10:00", close: "18:00" }] }),
    ).toEqual([]);
    expect(times({ earliest: at(`${MONDAY}T10:20`) })[0]).toBe("10:30");
  });

  test("the same wall-clock time is a different instant in each branch's timezone", () => {
    const first = (timeZone: string, date: string) =>
      freeSlots({ ...base, timeZone }, [
        date,
      ])[0]?.slots[0]?.startAt.toISOString();
    expect(first(TJ, "2026-10-31")).toBe("2026-10-31T17:00:00.000Z");
    expect(first(TJ, "2026-11-01")).toBe("2026-11-01T18:00:00.000Z");
    expect(first("America/Mexico_City", "2026-11-01")).toBe(
      "2026-11-01T16:00:00.000Z",
    );
    expect(first("America/New_York", "2026-11-01")).toBe(
      "2026-11-01T15:00:00.000Z",
    );
  });

  test("skips wall-clock times that DST removes or repeats", () => {
    const night = {
      branchHours: allWeek("00:00", "05:00"),
      barberHours: allWeek("00:00", "05:00"),
      slotIntervalMin: 30,
      durationMin: 30,
    };
    expect(times(night, "2026-03-08")).not.toContain("02:00");
    expect(times(night, "2026-03-08")).not.toContain("02:30");
    expect(times(night, "2026-03-08")).toContain("03:00");
    expect(times(night, "2026-11-01")).not.toContain("01:00");
    expect(times(night, "2026-11-01")).not.toContain("01:30");
  });
});

describe("isBookable", () => {
  test("accepts exactly the offered slots", () => {
    const busy = [{ start: at(`${MONDAY}T12:00`), end: at(`${MONDAY}T12:45`) }];
    expect(isBookable({ ...base, busy }, new Date(at(`${MONDAY}T10:00`)))).toBe(
      true,
    );
    expect(isBookable({ ...base, busy }, new Date(at(`${MONDAY}T10:05`)))).toBe(
      false,
    );
    expect(isBookable({ ...base, busy }, new Date(at(`${MONDAY}T12:00`)))).toBe(
      false,
    );
    expect(isBookable({ ...base, busy }, new Date(at(`${MONDAY}T19:00`)))).toBe(
      false,
    );
  });
});

test("localDate uses the branch's timezone, not the server's", () => {
  expect(localDate(Date.parse("2026-10-06T05:00:00Z"), TJ)).toBe("2026-10-05");
});
