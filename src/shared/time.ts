const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export function isLocalDateTime(value: string) {
  if (!LOCAL_DATE_TIME.test(value)) return false;
  try {
    Temporal.PlainDateTime.from(value, { overflow: "reject" });
    return true;
  } catch {
    return false;
  }
}

export function localToInstant(local: string, timeZone: string) {
  const zoned = Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone, {
    disambiguation: "compatible",
  });
  return new Date(zoned.epochMilliseconds);
}

export function instantToLocal(at: Date, timeZone: string) {
  return Temporal.Instant.fromEpochMilliseconds(at.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}

const zones = new Map<string, Intl.DateTimeFormat>();

/** An instant's calendar day ("2025-03-10") in its branch's time zone. */
export function localDate(at: Date, timeZone: string) {
  let format = zones.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
    }
    zones.set(timeZone, format);
  }
  return format.format(at);
}
