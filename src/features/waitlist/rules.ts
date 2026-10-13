export const MAX_ACTIVE = 5;

export const NOTIFY_PER_DAY = 3;

export const inWindow = (time: string, from?: string, to?: string) =>
  (from === undefined || time >= from) && (to === undefined || time <= to);
