// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstBy, groupBy } from '../lib/collections.mjs';

const WORDS = ['beta', 'apple', 'blue', 'avocado', 'cherry'];

/**
 * @param {string} word
 * @returns {string}
 */
const initial = (word) => word[0];

test('groupBy keeps keys in first-seen order and items in their order within each group', () => {
  const groups = groupBy(WORDS, initial);

  assert.deepEqual([...groups], [['b', ['beta', 'blue']], ['a', ['apple', 'avocado']], ['c', ['cherry']]]);
});

test('groupBy compares keys by identity, so equal-looking objects form separate groups', () => {
  const one = { id: 1 };
  const other = { id: 1 };

  const groups = groupBy([one, other, one], (item) => item);

  assert.deepEqual([...groups.values()].map((group) => group.length), [2, 1]);
});

test('groupBy and firstBy of no items are empty', () => {
  assert.equal(groupBy([], initial).size, 0);
  assert.equal(firstBy([], initial).size, 0);
});

test('firstBy keeps the first item for each key, in first-seen order', () => {
  const firsts = firstBy(WORDS, initial);

  assert.deepEqual([...firsts], [['b', 'beta'], ['a', 'apple'], ['c', 'cherry']]);
});

test('groupBy and firstBy accept any iterable, not only arrays', () => {
  const items = new Set(WORDS);

  assert.deepEqual([...groupBy(items, initial).keys()], ['b', 'a', 'c']);
  assert.deepEqual([...firstBy(items, initial).values()], ['beta', 'apple', 'cherry']);
});
