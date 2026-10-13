// @ts-check
// Notes opened from the code: hovering the text of an annotated line shows its notes in a row under it.
import { test, expect, reportUrl } from './reports.mjs';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('./reports.mjs').Box} Box */

// The Greeter line `public String greet(Name name)` carries a note in the demo fixture.
/** @param {Page} page */
function annotatedLine(page) {
  return page.locator('section.file[data-path="src/Greeter.java"] tr.annotated')
    .filter({ hasText: 'public String greet(Name name)' });
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
