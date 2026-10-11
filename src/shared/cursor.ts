export function collect<T>(cursor: AsyncIterable<T>): Promise<T[]>;
export function collect<T, R>(
  cursor: AsyncIterable<T>,
  pick: (doc: T) => R,
): Promise<R[]>;
export async function collect<T, R>(
  cursor: AsyncIterable<T>,
  pick?: (doc: T) => R,
): Promise<(T | R)[]> {
  const kept: (T | R)[] = [];
  for await (const doc of cursor) kept.push(pick ? pick(doc) : doc);
  return kept;
}

export function mapBy<T, K>(
  cursor: AsyncIterable<T>,
  key: (doc: T) => K,
): Promise<Map<K, T>>;
export function mapBy<T, K, R>(
  cursor: AsyncIterable<T>,
  key: (doc: T) => K,
  pick: (doc: T) => R,
): Promise<Map<K, R>>;
export async function mapBy<T, K, R>(
  cursor: AsyncIterable<T>,
  key: (doc: T) => K,
  pick?: (doc: T) => R,
): Promise<Map<K, T | R>> {
  const kept = new Map<K, T | R>();
  for await (const doc of cursor) kept.set(key(doc), pick ? pick(doc) : doc);
  return kept;
}
