import { describe, expect, test } from "bun:test";
import { instantToLocal, isLocalDateTime, localToInstant } from "./time";

const iso = (local: string, tz: string) =>
  localToInstant(local, tz).toISOString();

describe("localToInstant", () => {
  test("follows each branch's DST rules (US DST ends 2026-11-01)", () => {
    expect(iso("2026-10-31T10:00", "America/Tijuana")).toBe(
      "2026-10-31T17:00:00.000Z",
    );
    expect(iso("2026-11-01T10:00", "America/Tijuana")).toBe(
      "2026-11-01T18:00:00.000Z",
    );
    expect(iso("2026-11-01T10:00", "America/Mexico_City")).toBe(
      "2026-11-01T16:00:00.000Z",
    );
    expect(iso("2026-11-01T10:00", "America/New_York")).toBe(
      "2026-11-01T15:00:00.000Z",
    );
  });

  test("a time in the spring-forward gap moves forward; a repeated time takes the first one", () => {
    expect(iso("2026-03-08T02:30", "America/Tijuana")).toBe(
      "2026-03-08T10:30:00.000Z",
    );
    expect(iso("2026-11-01T01:30", "America/Tijuana")).toBe(
      "2026-11-01T08:30:00.000Z",
    );
  });
});

test("instantToLocal round-trips", () => {
  const at = new Date("2026-11-01T18:00:00Z");
  expect(instantToLocal(at, "America/Tijuana")).toBe("2026-11-01T10:00");
  expect(
    localToInstant(instantToLocal(at, "America/New_York"), "America/New_York"),
  ).toEqual(at);
});

test("isLocalDateTime accepts real dates only, without offset or seconds", () => {
  expect(isLocalDateTime("2026-12-20T09:00")).toBe(true);
  for (const value of [
    "2026-02-30T10:00",
    "2026-12-20T24:00",
    "2026-12-20T09:00:00",
    "2026-12-20T09:00Z",
    "2026-12-20",
  ]) {
    expect(isLocalDateTime(value)).toBe(false);
  }
});
