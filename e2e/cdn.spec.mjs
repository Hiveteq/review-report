// Highlighting and diagrams come from pinned CDN files; without them the page must still work.
import { test, expect, reportUrl } from './reports.mjs';

test.describe('with the CDNs reachable', () => {
  test.use({ cdn: true });

  test('the pinned highlight.js and Mermaid files load and pass their integrity checks', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.goto(reportUrl('single.html'));

    await expect(page.locator('td.code code.hljs').first()).toBeAttached();
    await expect(page.locator('pre.mermaid svg').first()).toBeVisible({ timeout: 15_000 });
    expect(consoleErrors.filter((t) => /integrity|digest|subresource/i.test(t))).toEqual([]);
  });
});

test('without the CDNs the page shows plain code and diagram source, and still works', async ({ page }) => {
  await page.goto(reportUrl('single.html'));

  await expect(page.locator('td.code code').first()).toBeVisible();
  await expect(page.locator('td.code code.hljs')).toHaveCount(0);
  await expect(page.locator('pre.mermaid').first()).toContainText('flowchart');
  await page.locator('section.file[data-path="src/Name.java"]').getByRole('checkbox', { name: 'Viewed' }).check();
  await expect(page.locator('section.chapter[data-files="src/Name.java"] .chapter-viewed')).toHaveText('All files viewed');
});
