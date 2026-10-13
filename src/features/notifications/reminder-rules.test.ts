import { describe, expect, test } from "bun:test";
import { dueReminder } from "./reminder-rules";

const H = 60 * 60 * 1000;
const start = new Date("2030-01-10T15:00:00Z");
const at = (hoursBefore: number) => new Date(start.getTime() - hoursBefore * H);
const booked = (hoursBefore: number) => ({
  startAt: start,
  createdAt: at(hoursBefore),
});

describe("dueReminder", () => {
  test("nothing before the 24 h mark", () => {
    expect(dueReminder(booked(72), at(25))).toBeUndefined();
  });

  test("24 h reminder from its moment on", () => {
    expect(dueReminder(booked(72), at(24))).toBe("h24");
    expect(dueReminder(booked(72), at(10))).toBe("h24");
  });

  test("2 h reminder wins once it is due, so a late sweep sends only the nearest", () => {
    expect(dueReminder(booked(72), at(2))).toBe("h2");
    expect(dueReminder(booked(72), at(0.5))).toBe("h2");
  });

  test("a booking made after a reminder's moment never gets that reminder", () => {
    expect(dueReminder(booked(20), at(19))).toBeUndefined();
    expect(dueReminder(booked(20), at(2))).toBe("h2");
    expect(dueReminder(booked(1), at(0.5))).toBeUndefined();
  });

  test("nothing once the appointment has started", () => {
    expect(dueReminder(booked(72), start)).toBeUndefined();
    expect(dueReminder(booked(72), at(-1))).toBeUndefined();
  });
});
