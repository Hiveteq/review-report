// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstBy } from '../lib/collections.mjs';

const WORDS = ['beta', 'apple', 'blue', 'avocado', 'cherry'];

/**
 * @param {string} word
 * @returns {string}
 */
const initial = (word) => word[0];

test('firstBy of no items is empty', () => {
  assert.equal(firstBy([], initial).size, 0);
});

test('firstBy keeps the first item for each key, in first-seen order', () => {
  const firsts = firstBy(WORDS, initial);

  assert.deepEqual([...firsts], [['b', 'beta'], ['a', 'apple'], ['c', 'cherry']]);
});

test('firstBy accepts any iterable, not only arrays', () => {
  const items = new Set(WORDS);

  assert.deepEqual([...firstBy(items, initial).values()], ['beta', 'apple', 'cherry']);
});
