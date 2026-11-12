// @ts-check
// Where notes go when the margin cannot hold them (a narrow block, split view, print), and how hover
// and pinned hints behave when the notes are laid out again.
import { test, expect, reportUrl, file, annotatedLine, NARROW, WIDE, resizeTo } from './reports.mjs';

/* global window -- the evaluate callbacks run in the browser, not in Node */

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */
/** @typedef {import('./reports.mjs').Box} Box */

/**
 * @param {Page} page
 * @returns {Locator}
 */
const marginNotes = (page) => page.locator('.notes-col .note');
/**
 * @param {Page} page
 * @returns {Locator}
 */
const belowNotes = (page) => page.locator('.notes-below .note');

/**
 * Waits for the margin notes to be laid out and counts them: every note of the page, as a reference
 * for the other placements.
 * @param {Page} page
 * @returns {Promise<number>}
 */
async function countMarginNotes(page) {
  await expect(marginNotes(page).first()).toBeVisible();
  const total = await marginNotes(page).count();
  expect(total).toBeGreaterThan(1);
  return total;
}

/**
 * A card's top, measured from the top of its file body, which an inserted note row does not move.
 * @param {Locator} block
 * @param {Locator} card
 * @returns {Promise<number>}
 */
async function topInBody(block, card) {
  const [box, body] = await Promise.all([card.boundingBox(), block.locator('.file-body').boundingBox()]);
  return /** @type {Box} */ (box).y - /** @type {Box} */ (body).y;
}

test('a block narrower than 900px lists all its notes below the code; a wide window brings back the margin', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  const total = await countMarginNotes(page);

  await page.setViewportSize(NARROW);

  await expect(page.locator('table.diff.unified + .notes-below .note')).toHaveCount(total);
  await expect(marginNotes(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Notes: margin (below hunks here)' })).toBeVisible();
  await page.setViewportSize(WIDE);
  await expect(marginNotes(page)).toHaveCount(total);
  await expect(page.locator('.notes-below')).toHaveCount(0);
});

test('split view lists every margin note below its hunk, and unified view brings back the margin', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  const total = await countMarginNotes(page);

  await page.getByRole('button', { name: 'Diff: unified' }).click();

  await expect(page.locator('table.diff.split + .notes-below .note')).toHaveCount(total);
  await expect(marginNotes(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Notes: margin (below hunks here)' })).toBeVisible();
  await page.getByRole('button', { name: 'Diff: split' }).click();
  await expect(marginNotes(page)).toHaveCount(total);
  await expect(page.locator('.notes-below')).toHaveCount(0);
});

test('a pinned note stays open and pinned under its line when a resize lays the notes out again', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  const line = annotatedLine(page);
  const rowUnderLine = line.locator('xpath=following-sibling::tr[1]');
  await line.locator('.note-marker').click();
  await expect(rowUnderLine).toContainClass('hint-row pinned');

  await resizeTo(page, NARROW);

  await expect(page.locator('tr.hint-row')).toHaveCount(1);
  await expect(rowUnderLine).toContainClass('hint-row pinned');
  await resizeTo(page, WIDE);
  await expect(page.locator('tr.hint-row')).toHaveCount(1);
  await expect(rowUnderLine).toContainClass('hint-row pinned');
});

// The diff toggle, because split view still has markers: the re-layout re-opens the pinned note, so
// only the click itself can close it. Inline notes have no markers and would let go of it anyway.
// Released, not just hidden: hovering opens an unpinned note again, which a held pin would block.
test('a click on a toolbar button releases a pinned note, like any other click on the page', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  await annotatedLine(page).locator('.note-marker').click();
  await expect(page.locator('tr.hint-row.pinned')).toBeVisible();

  await page.getByRole('button', { name: 'Diff: unified' }).click();

  await expect(page.getByRole('button', { name: 'Diff: split' })).toBeVisible();
  await expect(page.locator('tr.hint-row')).toHaveCount(0);
  await annotatedLine(page).locator('.hint-target').hover();
  await expect(page.locator('tr.hint-row:not(.pinned)')).toHaveCount(1);
});

test('after three re-layouts, hovering the code text opens one note and the line numbers close it', async ({ page }) => {
  await page.setViewportSize(NARROW);
  await page.goto(reportUrl('single.html'));
  await resizeTo(page, WIDE);
  await resizeTo(page, NARROW);
  await resizeTo(page, WIDE);
  const line = annotatedLine(page);

  await line.locator('.hint-target').hover();

  await expect(page.locator('tr.hint-row')).toHaveCount(1);
  await expect(page.locator('tr.hint-row')).toContainText('Signature changes from String to Name');
  await line.locator('td.num').first().hover();
  await expect(page.locator('tr.hint-row')).toHaveCount(0);
});

test('printing lists every note below the code, and the margin comes back after printing', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  const total = await countMarginNotes(page);

  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));

  await expect(belowNotes(page)).toHaveCount(total);
  await expect(marginNotes(page)).toHaveCount(0);
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(marginNotes(page)).toHaveCount(total);
  await expect(page.locator('.notes-below')).toHaveCount(0);
});

test('an open note moves only the margin notes below it down by its height, and closing it puts them back', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); // the cards slide otherwise; read them where they stop
  await page.goto(reportUrl('long.html'));
  const catalog = file(page, 'src/Catalog.java');
  const line = catalog.locator('table.diff.unified tr[data-new="200"]');
  /**
   * @param {number} n
   * @returns {Locator}
   */
  const card = (n) => catalog.locator('.notes-col .note').filter({ hasText: `Note on line ${n}.` });
  const cards = { above: card(50), own: card(200), below: card(350) };
  /** @returns {Promise<{ above: number, own: number, below: number }>} */
  const tops = async () => {
    const [above, own, below] = await Promise.all([cards.above, cards.own, cards.below].map((c) => topInBody(catalog, c)));
    return { above, own, below };
  };
  await line.scrollIntoViewIfNeeded();
  const before = await tops();

  await line.locator('.hint-target').hover();

  const hint = page.locator('tr.hint-row');
  await expect(hint).toBeVisible();
  const height = /** @type {Box} */ (await hint.boundingBox()).height;
  const open = await tops();
  expect(open.above).toBeCloseTo(before.above, 0);
  expect(open.own).toBeCloseTo(before.own, 0);
  expect(Math.abs(open.below - (before.below + height))).toBeLessThanOrEqual(1);
  await line.locator('td.num').first().hover();
  await expect(hint).toHaveCount(0);
  const closed = await tops();
  expect(closed.above).toBeCloseTo(before.above, 0);
  expect(closed.own).toBeCloseTo(before.own, 0);
  expect(closed.below).toBeCloseTo(before.below, 0);
});
