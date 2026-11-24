// @ts-check
// A collection helper the other modules share.

/**
 * The first item for each key, in the order the keys first appear.
 * @template T, K
 * @param {Iterable<T>} items
 * @param {(item: T) => K} keyOf
 * @returns {Map<K, T>}
 */
export function firstBy(items, keyOf) {
  return new Map(Array.from(Map.groupBy(items, keyOf), ([key, [first]]) => [key, first]));
}
