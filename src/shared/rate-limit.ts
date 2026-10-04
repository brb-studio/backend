const windows = new Map<string, { count: number; resetAt: number }>();

export function hit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
) {
  let window = windows.get(key);
  if (!window || window.resetAt <= now) {
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    }
    window = { count: 0, resetAt: now + windowMs };
    windows.set(key, window);
  }
  window.count++;
  return window.count <= limit;
}
