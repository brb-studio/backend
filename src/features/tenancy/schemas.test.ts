import { describe, expect, test } from "bun:test";
import {
  branchCreate,
  hoursOverlap,
  isTimeZone,
  tenantUpdate,
} from "./schemas";

const branch = {
  slug: "centro",
  name: "Centro",
  address: ["Av. Revolución 123", "Tijuana"],
  timeZone: "America/Tijuana",
  hours: [{ weekday: 1, open: "09:00", close: "20:00" }],
};

describe("isTimeZone", () => {
  test("IANA names only", () => {
    for (const tz of [
      "America/Tijuana",
      "America/New_York",
      "UTC",
      "Etc/GMT+5",
    ]) {
      expect(isTimeZone(tz)).toBe(true);
    }
    for (const tz of ["Mars/Olympus", "+05:00", "", "America/Tijuana;"]) {
      expect(isTimeZone(tz)).toBe(false);
    }
  });
});

describe("hoursOverlap", () => {
  test("split shifts may touch, not overlap; other weekdays are independent", () => {
    expect(
      hoursOverlap([
        { weekday: 1, open: "15:00", close: "18:00" },
        { weekday: 1, open: "10:00", close: "14:00" },
        { weekday: 2, open: "11:00", close: "16:00" },
      ]),
    ).toBe(false);
    expect(
      hoursOverlap([
        { weekday: 1, open: "10:00", close: "14:00" },
        { weekday: 1, open: "14:00", close: "18:00" },
      ]),
    ).toBe(false);
    expect(
      hoursOverlap([
        { weekday: 1, open: "10:00", close: "14:00" },
        { weekday: 1, open: "13:59", close: "18:00" },
      ]),
    ).toBe(true);
  });
});

describe("branchCreate", () => {
  test("fills booking defaults and keeps overrides", () => {
    expect(
      branchCreate.parse({ ...branch, booking: { bufferMin: 10 } }).booking,
    ).toEqual({
      slotIntervalMin: 15,
      bufferMin: 10,
      minNoticeMin: 60,
      windowDays: 14,
      cancelNoticeMin: 120,
    });
  });

  test("rejects inverted hours, non-integer minutes and unknown keys", () => {
    for (const input of [
      { ...branch, hours: [{ weekday: 1, open: "20:00", close: "09:00" }] },
      { ...branch, hours: [{ weekday: 7, open: "09:00", close: "20:00" }] },
      { ...branch, booking: { slotIntervalMin: 7.5 } },
      { ...branch, tenantId: "65f000000000000000000000" },
    ]) {
      expect(branchCreate.safeParse(input).success).toBe(false);
    }
  });
});

describe("tenantUpdate theme", () => {
  test("accepts allowlisted tokens and colors only", () => {
    expect(
      tenantUpdate.safeParse({
        theme: {
          accent: "#2563eb",
          canvas: { light: "#fff", dark: "oklch(20% 0 0)" },
        },
      }).success,
    ).toBe(true);
    for (const theme of [
      { accent: "red;} body{display:none" },
      { "not-a-token": "#fff" },
      { accent: { light: "#fff" } },
    ]) {
      expect(tenantUpdate.safeParse({ theme }).success).toBe(false);
    }
  });
});
