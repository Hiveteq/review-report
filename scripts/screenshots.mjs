// @ts-check
// Regenerates the README screenshots from the demo fixture (the Greeter change in test/), never from a real
// project. Needs Playwright's Chromium: `npm ci && npx playwright install chromium`.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

/* global document, window -- the page.waitForFunction and page.evaluate callbacks below run in the browser, not in Node. */

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = join(root, 'skills', 'review-report');
const shots = join(root, 'docs', 'screenshots');

/**
 * Renders the demo fixture to a single HTML file.
 * @param {string} html where to write the report
 */
function renderFixture(html) {
  const r = spawnSync(process.execPath, [join(skill, 'render.mjs'), '--story', join(skill, 'test', 'fixture.story.json'),
    '--diff-file', join(skill, 'test', 'fixture.diff'), '--single', '--out', html], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`render failed:\n${r.stderr}`);
}

/**
 * Waits until every Mermaid block has been replaced by its rendered diagram, so a shot never catches the source text.
 * @param {import('@playwright/test').Page} page
 */
async function diagramsReady(page) {
  try {
    await page.waitForFunction(() => {
      const blocks = [...document.querySelectorAll('pre.mermaid')];
      return blocks.length > 0 && blocks.every((block) => block.querySelector('svg'));
    }, undefined, { timeout: 15_000 });
  } catch (cause) {
    throw new Error('a diagram did not render within 15s; check the network access to the Mermaid CDN', { cause });
  }
}

/**
 * Light theme, margin notes: overview with its diagram, then the first chapters.
 * @param {import('@playwright/test').Page} page
 * @param {string} html
 */
async function shootMarginLight(page, html) {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto(pathToFileURL(html).href);
  await diagramsReady(page);
  await page.screenshot({ path: join(shots, 'report-margin-light.png'), clip: { x: 0, y: 0, width: 1440, height: 1700 }, fullPage: true, animations: 'disabled' });
}

/**
 * Hovering an annotated line opens its note under the line.
 * @param {import('@playwright/test').Page} page
 */
async function shootHoverHint(page) {
  const greeter = page.locator('section.file[data-path="src/Greeter.java"]');
  await greeter.scrollIntoViewIfNeeded();
  await greeter.locator('code.hint-target').nth(1).hover();
  await greeter.locator('tr.hint-row').first().waitFor({ state: 'visible' });
  await greeter.screenshot({ path: join(shots, 'hover-hint.png'), animations: 'disabled' });
}

/**
 * Dark theme, split diff, one file ticked as viewed, progress in the sidebar.
 * @param {import('@playwright/test').Page} page
 */
async function shootDarkSplit(page) {
  await page.mouse.move(5, 5);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('review-report-theme', 'dark'); localStorage.setItem('review-report-diff', 'split'); });
  await page.reload();
  await diagramsReady(page);
  await page.locator('section.file[data-path="src/Name.java"] .viewed-toggle').check();
  await page.locator('#chapter-2').scrollIntoViewIfNeeded();
  // The fixture report always has a first chapter, so getElementById finds it.
  await page.evaluate(() => window.scrollTo(0, /** @type {HTMLElement} */ (document.getElementById('chapter-1')).offsetTop - 20));
  await page.screenshot({ path: join(shots, 'report-dark-split.png'), animations: 'disabled' });
}

const out = mkdtempSync(join(tmpdir(), 'rr-shots-'));
let browser;
try {
  const html = join(out, 'report.html');
  renderFixture(html);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  await shootMarginLight(page, html);
  await shootHoverHint(page);
  await shootDarkSplit(page);
  console.log('screenshots written to docs/screenshots');
} finally {
  // Remove the folder first so a failing close() cannot leave it behind.
  rmSync(out, { recursive: true, force: true });
  await browser?.close();
}
