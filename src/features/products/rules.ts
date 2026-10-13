export const MAX_LINES = 10;
export const MAX_QUANTITY = 20;
export const MAX_OPEN = 3;
const RESERVE_MS = 7 * 24 * 60 * 60 * 1000;

export function mergeLines(items: { product: string; quantity: number }[]) {
  const lines = new Map<string, number>();
  for (const { product, quantity } of items) {
    lines.set(
      product,
      Math.min(MAX_QUANTITY, (lines.get(product) ?? 0) + quantity),
    );
  }
  return lines;
}

export const totalOf = (items: { priceMinor: number; quantity: number }[]) =>
  items.reduce((sum, i) => sum + i.priceMinor * i.quantity, 0);

export const expiryFrom = (now: Date) => new Date(now.getTime() + RESERVE_MS);
