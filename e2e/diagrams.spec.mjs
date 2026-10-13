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
  ['wide flowchart', 'Stage ten of the pipeline'],
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

// Drawn and natural width of a diagram box, and whether the box scrolls sideways.
function sizeOf(box) {
  return box.evaluate((pre) => {
    const svg = pre.querySelector('svg');
    return { drawn: svg.getBoundingClientRect().width, natural: svg.viewBox.baseVal.width, scrolls: pre.scrollWidth > pre.clientWidth };
  });
}

test.describe('a diagram wider than its column', () => {
  const wide = (page) => page.locator('figure.diagram').filter({ hasText: 'Stage ten of the pipeline' });

  test.beforeEach(async ({ page }) => {
    await page.goto(reportUrl('diagrams.html'));
    await expect(wide(page).locator('svg')).toBeVisible({ timeout: 15_000 });
  });

  test('fits the column by default and offers Full size; narrow diagrams get no button', async ({ page }) => {
    const size = await sizeOf(wide(page).locator('pre.mermaid'));

    expect(size.drawn).toBeLessThan(size.natural - 1);
    expect(size.scrolls).toBe(false);
    await expect(wide(page).getByRole('button', { name: 'Full size' })).toBeVisible();
    await expect(page.locator('figure.diagram').first().getByRole('button')).toHaveCount(0);
  });

  test('Full size draws it at natural width with a sideways scroll; Fit to width goes back', async ({ page }) => {
    await wide(page).getByRole('button', { name: 'Full size' }).click();

    let size = await sizeOf(wide(page).locator('pre.mermaid'));
    expect(Math.abs(size.drawn - size.natural)).toBeLessThanOrEqual(1);
    expect(size.scrolls).toBe(true);

    await wide(page).getByRole('button', { name: 'Fit to width' }).click();

    size = await sizeOf(wide(page).locator('pre.mermaid'));
    expect(size.drawn).toBeLessThan(size.natural - 1);
  });

  test('stays at full size after a theme switch redraws it', async ({ page }) => {
    await wide(page).getByRole('button', { name: 'Full size' }).click();
    await wide(page).locator('svg').evaluate((svg) => { svg.dataset.before = 'theme'; });

    await page.getByRole('button', { name: 'Theme' }).click();

    await expect(wide(page).locator('svg:not([data-before])')).toBeVisible({ timeout: 15_000 }); // the redrawn diagram
    const size = await sizeOf(wide(page).locator('pre.mermaid'));
    expect(Math.abs(size.drawn - size.natural)).toBeLessThanOrEqual(1);
    await expect(wide(page).getByRole('button', { name: 'Fit to width' })).toBeVisible();
  });
});
