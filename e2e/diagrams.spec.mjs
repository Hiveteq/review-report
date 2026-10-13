// Several Mermaid diagrams on one page, rendered from the pinned CDN file.
import { test, expect, reportUrl } from './reports.mjs';

test.use({ cdn: true });

// In page order: each diagram's type and a label only that diagram draws.
const DIAGRAMS = [
  ['marked flowchart', 'Greeter.greet'],
  ['before/after pair', 'Cache hit?'],
  ['state machine', 'Rejected'],
  ['sequence', 'greet(name)'],
  ['entity diagram', 'AUTHOR'],
];

async function expectEachDiagramInItsOwnBox(page) {
  const boxes = page.locator('pre.mermaid');
  await expect(boxes).toHaveCount(DIAGRAMS.length);
  for (const [i, [kind, label]] of DIAGRAMS.entries()) {
    await expect(boxes.nth(i).locator('svg'), `${kind}: one drawing`).toHaveCount(1, { timeout: 15_000 });
    await expect(boxes.nth(i).locator('svg'), `${kind}: its own content`).toContainText(label);
  }
}

test('every diagram on a page is drawn in its own box', async ({ page }) => {
  await page.goto(reportUrl('diagrams.html'));

  await expectEachDiagramInItsOwnBox(page);
});

test('quick theme switches redraw every diagram in its own box', async ({ page }) => {
  await page.goto(reportUrl('diagrams.html'));
  const toggle = page.getByRole('button', { name: 'Theme' });

  await toggle.click();
  await toggle.click();
  await toggle.click();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectEachDiagramInItsOwnBox(page);
});

test('text on new and changed boxes stays dark in the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(reportUrl('diagrams.html'));

  const label = page.locator('pre.mermaid g.node.new .nodeLabel').first();

  await expect(label).toHaveCSS('color', 'rgb(31, 35, 40)', { timeout: 15_000 });
});
