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
