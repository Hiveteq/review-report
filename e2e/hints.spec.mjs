// @ts-check
// Notes opened from the code: hovering the text of an annotated line shows its notes in a row under it.
import { test, expect, reportUrl, file, annotatedLine, NARROW, WIDE, resizeTo } from './reports.mjs';

/* global MutationObserver -- the evaluate callbacks run in the browser, not in Node */

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */
/** @typedef {import('./reports.mjs').Box} Box */

/**
 * The types of the listeners on one element, as Chromium's DevTools protocol lists them.
 * @param {Page} page
 * @param {string} selector CSS selector of the element
 * @returns {Promise<string[]>}
 */
async function listenerTypes(page, selector) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    if (!result.objectId) throw new Error(`no element matches ${selector}`);
    const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    return listeners.map((listener) => listener.type);
  } finally {
    await cdp.detach();
  }
}

/**
 * Starts counting the rows added to or removed from the table of a line.
 * @param {Locator} line a code line
 * @returns {Promise<() => Promise<number>>} reads the count so far
 */
async function countRowChanges(line) {
  const counter = await line.evaluateHandle((row) => {
    /** @type {MutationRecord[]} */
    const records = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(/** @type {Node} */ (row.parentNode), { childList: true });
    return () => [...records, ...observer.takeRecords()].length;
  });
  return () => counter.evaluate((count) => count());
}

test.beforeEach(async ({ page }) => {
  await page.goto(reportUrl('single.html'));
});

test('hovering the code text opens its note under the line, pushing the next line down', async ({ page }) => {
  const line = annotatedLine(page);

  await line.locator('.hint-target').hover();

  const hint = page.locator('tr.hint-row');
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('Signature changes from String to Name');
  const next = line.locator('xpath=following-sibling::tr[contains(@class, "line")][1]');
  const hintBox = /** @type {Box} */ (await hint.boundingBox());
  expect(/** @type {Box} */ (await next.boundingBox()).y).toBeGreaterThanOrEqual(hintBox.y + hintBox.height - 1);
});

test('moving the pointer to the line numbers closes the note', async ({ page }) => {
  const line = annotatedLine(page);
  await line.locator('.hint-target').hover();
  await expect(page.locator('tr.hint-row')).toBeVisible();

  await line.locator('td.num').first().hover();

  await expect(page.locator('tr.hint-row')).toHaveCount(0);
});

test('clicking the numbered circle pins the note until the page is clicked', async ({ page }) => {
  const line = annotatedLine(page);

  await line.locator('.note-marker').click();
  await line.locator('td.num').first().hover();

  await expect(page.locator('tr.hint-row.pinned')).toBeVisible();
  await page.getByRole('heading', { level: 1 }).click();
  await expect(page.locator('tr.hint-row')).toHaveCount(0);
});

test('hovering the numbered circle opens the note under its line, unpinned', async ({ page }) => {
  const line = annotatedLine(page);

  await line.locator('.note-marker').hover();

  await expect(line.locator('xpath=following-sibling::tr[1]')).toContainClass('hint-row');
  await expect(page.locator('tr.hint-row:not(.pinned)')).toContainText('Signature changes from String to Name');
});

test('after releasing a pin with the circle, moving to the code text opens the note again', async ({ page }) => {
  const line = annotatedLine(page);
  const circle = line.locator('.note-marker');
  await circle.click();
  await expect(page.locator('tr.hint-row.pinned')).toHaveCount(1);
  await circle.click();
  await expect(page.locator('tr.hint-row')).toHaveCount(0);

  await line.locator('.hint-target').hover();

  await expect(page.locator('tr.hint-row:not(.pinned)')).toContainText('Signature changes from String to Name');
});

// The circle and the code text both open the same note. Passing from one to the other must not close
// and reopen it, which would make it flicker and the code below it jump.
test('moving the pointer from the circle to the code text and back keeps the note open, without reopening it', async ({ page }) => {
  const line = annotatedLine(page);
  const circle = line.locator('td.note-anchor > .note-marker');
  await circle.hover();
  await expect(page.locator('tr.hint-row')).toHaveCount(1);
  const rowChanges = await countRowChanges(line);

  await line.locator('.hint-target').hover();
  await circle.hover();

  await expect(page.locator('tr.hint-row:not(.pinned)')).toContainText('Signature changes from String to Name');
  expect(await rowChanges()).toBe(0);
});

// Every layout replaces the lines' circles and hover targets. Listeners on a line's own elements would
// pile up with each re-layout, so the page listens on the document instead.
test('after three re-layouts, the code text of an annotated line carries no hover listeners of its own', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', "only Chromium's DevTools protocol lists an element's listeners");
  const newLine = await annotatedLine(page).getAttribute('data-new');

  await resizeTo(page, NARROW);
  await resizeTo(page, WIDE);
  await resizeTo(page, NARROW);

  const types = await listenerTypes(page, `section.file[data-path="src/Greeter.java"] tr[data-new="${newLine}"] code.hint-target`);
  expect(types.filter((type) => type.startsWith('mouse'))).toEqual([]);
});

// Inline notes already sit under their line. The margin layout's hover targets must not outlive it.
test('after switching to inline notes, hovering the code text opens no second copy of its note', async ({ page }) => {
  await page.getByRole('button', { name: 'Notes: margin' }).click();
  await expect(page.getByRole('button', { name: 'Notes: inline' })).toBeVisible();
  const line = file(page, 'src/Greeter.java').locator('tr.line').filter({ hasText: 'public String greet(Name name)' });

  await line.locator('td.code code').hover();

  await expect(line.locator('xpath=following-sibling::tr[1]')).toContainClass('comment');
  await expect(page.locator('tr.hint-row')).toHaveCount(0);
});

test.describe('with the code highlighted', () => {
  test.use({ cdn: true });

  // Highlighting splits the code text into many token elements. Passing from one to another must not
  // close and reopen the note, which would make it flicker and the code below it jump.
  test('moving the pointer across highlighted tokens keeps the note open, without reopening it', async ({ page }) => {
    const line = annotatedLine(page);
    const tokens = line.locator('.hint-target span');
    await expect(tokens.nth(1)).toBeVisible();
    await tokens.first().hover();
    await expect(page.locator('tr.hint-row')).toHaveCount(1);
    const rowChanges = await countRowChanges(line);

    await tokens.last().hover();

    await expect(page.locator('tr.hint-row')).toHaveCount(1);
    expect(await rowChanges()).toBe(0);
  });
});
