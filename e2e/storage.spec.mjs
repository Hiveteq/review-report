// @ts-check
// Viewed ticks beyond one page: another tab of the same report, typing in a text field, the stored
// format that ticks saved by earlier versions of the page script are in, damaged stored values, and
// file paths that are also names of built-in object properties.
import { test, expect, reportUrl, file, viewed, chapterMark } from './reports.mjs';

/** @typedef {import('@playwright/test').Page} Page */

test('a tick and an untick in one tab show in another tab of the same report', async ({ page, otherPage }) => {
  await page.goto(reportUrl('single.html'));
  await otherPage.goto(reportUrl('single.html'));

  await viewed(page, 'src/Name.java').check();

  await expect(viewed(otherPage, 'src/Name.java')).toBeChecked();
  await expect(chapterMark(otherPage, 'src/Name.java')).toHaveText('All files viewed');
  await viewed(page, 'src/Name.java').uncheck();
  await expect(viewed(otherPage, 'src/Name.java')).not.toBeChecked();
  await expect(chapterMark(otherPage, 'src/Name.java')).toHaveText('0 of 1 files viewed');
});

// Each kind of field the reader can type into; role and name make them findable alike.
const TEXT_FIELDS = [
  { kind: 'a text input', html: '<input aria-label="Search">' },
  { kind: 'a text area', html: '<textarea aria-label="Search"></textarea>' },
  { kind: 'an editable element', html: '<div contenteditable="true" role="textbox" aria-label="Search"></div>' },
];

for (const { kind, html } of TEXT_FIELDS) {
  test(`the v key ticks nothing while the reader types in ${kind}`, async ({ page }) => {
    await page.goto(reportUrl('single.html'));
    const greeter = file(page, 'src/Greeter.java');
    await greeter.locator('header.file-header').evaluate((header, markup) => header.insertAdjacentHTML('beforeend', markup), html);
    const field = page.getByRole('textbox', { name: 'Search' });
    await greeter.locator('td.code').first().hover(); // `v` acts on the file under the pointer
    await field.focus();

    await page.keyboard.press('v');

    // The field got the key, so the page has handled it by now.
    await expect.poll(() => field.evaluate((el) => ('value' in el ? el.value : el.textContent))).toBe('v');
    await expect(page.getByRole('checkbox', { name: 'Viewed', checked: true })).toHaveCount(0);
  });
}

/**
 * The stored format, which readers' browsers already hold: one key per report, holding each ticked
 * file's path and diff hash.
 * @param {Page} page
 * @returns {Promise<{ key: string, hash: string | null }>} the storage key of the open report, and the diff hash of src/Name.java
 */
async function storedFormat(page) {
  return { key: await viewedKey(page), hash: await file(page, 'src/Name.java').getAttribute('data-hash') };
}

/**
 * @param {Page} page
 * @returns {Promise<string>} the key the open report stores its ticks under
 */
async function viewedKey(page) {
  return `review-report:viewed:${await page.locator('html').getAttribute('data-report-id')}`;
}

test('ticks stored by an earlier version of the page still show', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  const { key, hash } = await storedFormat(page);
  await page.evaluate(([k, value]) => localStorage.setItem(k, value), [key, JSON.stringify({ 'src/Name.java': hash })]);

  await page.reload();

  await expect(viewed(page, 'src/Name.java')).toBeChecked();
});

test('a tick is stored in the format earlier versions read', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  const { key, hash } = await storedFormat(page);

  await viewed(page, 'src/Name.java').check();

  await expect.poll(async () => JSON.parse(await page.evaluate((k) => localStorage.getItem(k) ?? 'null', key)))
    .toEqual({ 'src/Name.java': hash });
});

// Stored values the page did not write as it expects: a hand edit, another tool, a write cut off
// halfway. The page treats them as no ticks, and the reader's next tick is stored as usual.
for (const damaged of ['5', '[]', '{bad']) {
  test(`stored ticks of ${damaged} neither break the page nor block a new tick`, async ({ page }) => {
    await page.goto(reportUrl('single.html'));
    const { key, hash } = await storedFormat(page);
    await page.evaluate(([k, value]) => localStorage.setItem(k, value), [key, damaged]);
    await page.reload();

    await viewed(page, 'src/Name.java').check();

    await expect(chapterMark(page, 'src/Name.java')).toHaveText('All files viewed');
    await expect.poll(async () => JSON.parse(await page.evaluate((k) => localStorage.getItem(k) ?? 'null', key)))
      .toEqual({ 'src/Name.java': hash });
  });
}

test('a damaged earlier render does not stop ticks carrying over from another earlier render', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  const { key, hash } = await storedFormat(page);
  // Earlier renders of the same report share the id up to its last eight hex digits.
  const stem = key.replace(/-[0-9a-f]{8}$/, '');
  const ticks = JSON.stringify({ 'src/Name.java': hash });
  await page.evaluate(([damagedKey, goodKey, value]) => {
    localStorage.setItem(damagedKey, '{bad');
    localStorage.setItem(goodKey, value);
  }, [`${stem}-00000000`, `${stem}-11111111`, ticks]);

  await page.reload();

  await expect(viewed(page, 'src/Name.java')).toBeChecked();
});

// Every plain object answers to these names through its prototype. Ticks kept in an object keyed by path
// must count only the files the reader ticked, and the `__proto__` one must be storable at all.
test.describe('files named like built-in object properties', () => {
  const PATHS = ['constructor', '__proto__'];

  /**
   * @param {Page} page
   * @returns {import('@playwright/test').Locator} the viewed count of the chapter that shows both files
   */
  const mark = (page) => page.locator(`section.chapter[data-files="${PATHS.join('|')}"] .chapter-viewed`);

  /**
   * The stored ticks as entries, not as the parsed object: an own `__proto__` key would not survive
   * the copy from the page into the test.
   * @param {Page} page
   * @param {string} key
   * @returns {Promise<[string, unknown][]>}
   */
  const storedEntries = (page, key) => page.evaluate((k) => Object.entries(JSON.parse(localStorage.getItem(k) ?? '{}')), key);

  test('count as unticked after load, and again after a tick and an untick in another tab', async ({ page, otherPage }) => {
    await page.goto(reportUrl('prototype-names.html'));
    await otherPage.goto(reportUrl('prototype-names.html'));
    await expect(mark(page)).toHaveText('0 of 2 files viewed');
    for (const path of PATHS) await expect(viewed(page, path)).not.toBeChecked();

    // The tick shows here first, so the untick after it is read from a storage event, not at load.
    await viewed(otherPage, 'constructor').check();
    await expect(mark(page)).toHaveText('1 of 2 files viewed');
    await viewed(otherPage, 'constructor').uncheck();

    await expect(mark(page)).toHaveText('0 of 2 files viewed');
    for (const path of PATHS) await expect(viewed(page, path)).not.toBeChecked();
  });

  test('are stored and shown once ticked, and still ticked after a reload', async ({ page }) => {
    await page.goto(reportUrl('prototype-names.html'));
    const key = await viewedKey(page);
    const hashes = await Promise.all(PATHS.map((path) => file(page, path).getAttribute('data-hash')));

    for (const path of PATHS) await viewed(page, path).check();

    await expect(mark(page)).toHaveText('All files viewed');
    await expect.poll(() => storedEntries(page, key)).toEqual(PATHS.map((path, i) => [path, hashes[i]]));
    await page.reload();
    for (const path of PATHS) await expect(viewed(page, path)).toBeChecked();
  });
});
