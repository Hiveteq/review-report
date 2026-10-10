// Viewed ticks: stored per report in localStorage, shown per file, per chapter and in the totals.
import { test, expect, reportUrl } from './reports.mjs';

const file = (page, path) => page.locator(`section.file[data-path="${path}"]`);
const viewed = (page, path) => file(page, path).getByRole('checkbox', { name: 'Viewed' });
const chapterMark = (page, path) => page.locator(`section.chapter[data-files="${path}"] .chapter-viewed`);

test('ticking every file of a chapter marks the chapter and the totals', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  await expect(chapterMark(page, 'src/Name.java')).toHaveText('0 of 1 files viewed');

  await viewed(page, 'src/Name.java').check();

  await expect(chapterMark(page, 'src/Name.java')).toHaveText('All files viewed');
  await expect(page.locator('.viewed-count').first()).toHaveText(/^1 of \d+ viewed$/);
});

test('unticking a file clears its chapter mark', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  await viewed(page, 'src/Name.java').check();

  await viewed(page, 'src/Name.java').uncheck();

  await expect(chapterMark(page, 'src/Name.java')).toHaveText('0 of 1 files viewed');
});

test('a tick survives a reload', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  await viewed(page, 'src/Name.java').check();

  await page.reload();

  await expect(viewed(page, 'src/Name.java')).toBeChecked();
});

test('a tick shows in the sidebar of the other pages of a paged report', async ({ page }) => {
  await page.goto(reportUrl('paged/chapter-01.html'));
  await viewed(page, 'src/Name.java').check();

  await page.goto(reportUrl('paged/chapter-02.html'));

  await expect(page.locator('.toc li[data-files="src/Name.java"]')).toHaveClass(/\bis-viewed\b/);
});

test('the v key toggles the file under the pointer', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  await file(page, 'src/Greeter.java').locator('td.code').first().hover();

  await page.keyboard.press('v');

  await expect(viewed(page, 'src/Greeter.java')).toBeChecked();
});

test.describe('after a re-render', () => {
  test('ticks carry over only for files whose diff is unchanged', async ({ page }) => {
    await page.goto(reportUrl('single.html'));
    await viewed(page, 'src/Name.java').check();
    await viewed(page, 'src/Greeter.java').check();

    await page.goto(reportUrl('rerendered.html'));

    await expect(viewed(page, 'src/Name.java')).toBeChecked();
    await expect(viewed(page, 'src/Greeter.java')).not.toBeChecked();
  });

  test('a carried-over tick the reader removes stays removed', async ({ page }) => {
    await page.goto(reportUrl('single.html'));
    await viewed(page, 'src/Name.java').check();
    await page.goto(reportUrl('rerendered.html'));
    await viewed(page, 'src/Name.java').uncheck();

    await page.reload();

    await expect(viewed(page, 'src/Name.java')).not.toBeChecked();
  });
});

test('another report keeps its own ticks', async ({ page }) => {
  await page.goto(reportUrl('single.html'));
  await viewed(page, 'src/Name.java').check();

  await page.goto(reportUrl('other.html'));

  await expect(viewed(page, 'src/Name.java')).not.toBeChecked();
});
