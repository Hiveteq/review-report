// @ts-check
// Small collection helpers the other modules share. The skill still supports Node 20, which lacks
// Map.groupBy, so grouping is written out here once.

/**
 * Groups items by the key each one gives, as Map.groupBy does. Keys keep the order they first
 * appear in, and each group keeps the items' order.
 * @template T, K
 * @param {Iterable<T>} items
 * @param {(item: T) => K} keyOf
 * @returns {Map<K, T[]>}
 */
export function groupBy(items, keyOf) {
  /** @type {Map<K, T[]>} */
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * The first item for each key, in the order the keys first appear.
 * @template T, K
 * @param {Iterable<T>} items
 * @param {(item: T) => K} keyOf
 * @returns {Map<K, T>}
 */
export function firstBy(items, keyOf) {
  return new Map(Array.from(groupBy(items, keyOf), ([key, [first]]) => [key, first]));
}
