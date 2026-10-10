// Page-wide settings (diff layout, notes placement, theme) and the sticky file header.
import { test, expect, reportUrl } from './reports.mjs';

const file = (page, path) => page.locator(`section.file[data-path="${path}"]`);

// Opens a report with the browser's own scroll anchoring off, so a kept place proves the page script
// kept it. Not every engine anchors, and none anchors on every change.
async function openWithoutScrollAnchoring(page, name) {
  await page.goto(reportUrl(name));
  await page.addStyleTag({ content: 'html, body { overflow-anchor: none; }' });
}

// Scrolls so the element's top edge sits `y` pixels below the top of the viewport.
async function scrollTo(locator, y) {
  await locator.evaluate((el, y) => window.scrollBy(0, el.getBoundingClientRect().top - y), y);
}

test('split view applies to every file and carries to the other pages', async ({ page }) => {
  await page.goto(reportUrl('paged/chapter-01.html'));

  await page.getByRole('button', { name: 'Diff: unified' }).click();

  await expect(page.getByRole('button', { name: 'Diff: split' })).toBeVisible();
  await expect(page.locator('table.diff.split').first()).toBeVisible();
  await page.goto(reportUrl('paged/chapter-02.html'));
  await expect(page.locator('table.diff.split').first()).toBeVisible();
  await expect(page.locator('table.diff.unified').first()).toBeHidden();
});

test('switching the diff layout keeps the line the reader was on in place', async ({ page }) => {
  await openWithoutScrollAnchoring(page, 'long.html');
  const unifiedRow = file(page, 'src/Catalog.java').locator('table.diff.unified tr[data-new="200"]');
  await scrollTo(unifiedRow, 300);

  await page.getByRole('button', { name: 'Diff: unified' }).click();

  const splitRow = file(page, 'src/Catalog.java').locator('table.diff.split tr.line')
    .filter({ has: page.locator('td.num.new', { hasText: /^200$/ }) });
  await expect(splitRow).toBeVisible();
  const box = await splitRow.boundingBox();
  expect(Math.abs(box.y - 300)).toBeLessThanOrEqual(2);
});

test('switching notes to inline keeps the line the reader was on in place', async ({ page }) => {
  await openWithoutScrollAnchoring(page, 'long.html');
  const row = file(page, 'src/Catalog.java').locator('table.diff.unified tr[data-new="200"]');
  await scrollTo(row, 300);

  await page.getByRole('button', { name: 'Notes: margin' }).click(); // adds a note row above, at line 50

  await expect(page.getByRole('button', { name: 'Notes: inline' })).toBeVisible();
  expect(Math.abs((await row.boundingBox()).y - 300)).toBeLessThanOrEqual(2);
});

test('notes switch between the margin and inline rows, and the choice persists', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  await expect(page.locator('.notes-col .note').first()).toBeVisible();

  await page.getByRole('button', { name: 'Notes: margin' }).click();

  await expect(page.locator('tr.comment').first()).toBeVisible();
  await expect(page.locator('.notes-col .note')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Notes: inline' })).toBeVisible();
  await expect(page.locator('tr.comment').first()).toBeVisible();
});

test('the theme toggle switches page and code colours, and the choice persists', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(reportUrl('single.html'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: 'Theme' }).click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#hljs-dark')).toHaveJSProperty('disabled', false);
  await expect(page.locator('#hljs-light')).toHaveJSProperty('disabled', true);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test.describe('a file longer than the screen', () => {
  test('keeps its header and Viewed box on screen while its body scrolls past', async ({ page }) => {
    await page.goto(reportUrl('long.html'));

    await scrollTo(file(page, 'src/Catalog.java').locator('tr[data-new="200"]'), 400);

    const header = file(page, 'src/Catalog.java').locator('header.file-header');
    expect((await header.boundingBox()).y).toBeCloseTo(0, 0);
    await expect(file(page, 'src/Catalog.java').getByRole('checkbox', { name: 'Viewed' })).toBeInViewport();
  });

  test('ticked from the stuck header, it folds and the next file comes up', async ({ page }) => {
    await page.goto(reportUrl('long.html'));
    await scrollTo(file(page, 'src/Catalog.java').locator('tr[data-new="200"]'), 400);

    await file(page, 'src/Catalog.java').getByRole('checkbox', { name: 'Viewed' }).check();

    await expect(file(page, 'src/Next.java').locator('header.file-header')).toBeInViewport();
  });
});
