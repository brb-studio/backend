export function corsOrigin(
  origin: string,
  allowed: { origins: string; frontendUrl?: string; platformDomain: string },
) {
  const list = new Set(
    allowed.origins
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  );
  if (allowed.frontendUrl) list.add(new URL(allowed.frontendUrl).origin);
  if (list.has(origin)) return origin;
  try {
    const { protocol, hostname } = new URL(origin);
    const tenant = hostname.endsWith(`.${allowed.platformDomain}`);
    return tenant && (protocol === "https:" || hostname.endsWith(".localhost"))
      ? origin
      : "";
  } catch {
    return "";
  }
}
