/** IVA at the general rate, in basis points (16%). */
export const IVA_RATE_BPS = 1600;

/**
 * Splits a total that already includes IVA into its base and its tax, in minor units. Rounds the base
 * half up, so base + tax always equals the total the customer paid.
 */
export function ivaIncluded(totalMinor: number) {
  const baseMinor = Math.round((totalMinor * 10_000) / (10_000 + IVA_RATE_BPS));
  return { baseMinor, ivaMinor: totalMinor - baseMinor };
}

/** The breakdown a customer sees, only for shops that turned IVA on. */
export const ivaFor = (enabled: boolean | undefined, totalMinor: number) =>
  enabled ? { iva: ivaIncluded(totalMinor) } : {};
