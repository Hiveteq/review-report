// @ts-check
// Where globalSetup renders the reports, and the shared test fixture and helpers every spec imports.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test as base, expect } from '@playwright/test';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */
/** @typedef {import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions} TestArgs */
/** @typedef {import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions} WorkerArgs */

/**
 * A locator's bounding box. boundingBox() returns null only for an element that is not rendered;
 * the specs read it for elements they have just seen on the page.
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */

// globalSetup renders the reports into a fresh folder of its own and names it in this environment
// variable, so two runs at once (two checkouts, say) never delete each other's reports. The workers
// inherit the variable.
export const REPORTS_ENV = 'REVIEW_REPORT_E2E_DIR';

/**
 * The folder globalSetup rendered this run's reports into. Playwright loads the spec files before
 * globalSetup runs, so the folder is looked up when a test opens a report, not when this module loads.
 * @returns {string}
 */
function reportsDir() {
  const dir = process.env[REPORTS_ENV];
  if (!dir) throw new Error(`${REPORTS_ENV} is not set: the Playwright globalSetup in e2e/global-setup.mjs sets it to the folder it renders the reports into, so run the specs with \`playwright test\``);
  return dir;
}

// Mermaid comes from the CDN and draws one diagram at a time, so a page of them takes a while.
export const DIAGRAM_TIMEOUT = 15_000;

/**
 * file:// URL of a rendered report: 'single.html', or a page of the paged one such as 'paged/chapter-02.html'.
 * @param {string} name
 * @returns {string}
 */
export function reportUrl(name) {
  const dir = reportsDir();
  const path = name.startsWith('paged/') ? join(dir, 'paged', name.slice('paged/'.length)) : join(dir, name);
  return pathToFileURL(path).href;
}

/**
 * The block of one changed file, by its path in the diff.
 * @param {Page} page
 * @param {string} path
 * @returns {Locator}
 */
export function file(page, path) {
  return page.locator(`section.file[data-path="${path}"]`);
}

/**
 * The Viewed tick box in a file's header.
 * @param {Page} page
 * @param {string} path
 * @returns {Locator}
 */
export function viewed(page, path) {
  return file(page, path).getByRole('checkbox', { name: 'Viewed' });
}

/**
 * The viewed count in the heading of the chapter that holds just this file.
 * @param {Page} page
 * @param {string} path
 * @returns {Locator}
 */
export function chapterMark(page, path) {
  return page.locator(`section.chapter[data-files="${path}"] .chapter-viewed`);
}

// Margin notes need a file block of at least 900px; the narrow window leaves the block narrower.
export const NARROW = { width: 800, height: 900 };
export const WIDE = { width: 1440, height: 900 };

/**
 * Resizes the window and waits for the notes to be laid out again, which the page does after a short
 * pause. The two sizes put the notes in different places, so the new layout is visible.
 * @param {Page} page
 * @param {typeof NARROW | typeof WIDE} size
 */
export async function resizeTo(page, size) {
  await page.setViewportSize(size);
  await expect(page.locator(size === WIDE ? '.notes-col .note' : '.notes-below .note').first()).toBeVisible();
}

/**
 * The Greeter line `public String greet(Name name)`, which carries a note in the demo fixture.
 * @param {Page} page
 * @returns {Locator}
 */
export function annotatedLine(page) {
  return file(page, 'src/Greeter.java').locator('tr.annotated').filter({ hasText: 'public String greet(Name name)' });
}

// Every test fails on an uncaught page error, so a broken page script never passes quietly.
// CDN requests are blocked unless a test opts in with test.use({ cdn: true }): the page must work
// without highlight.js and Mermaid, and the other tests then run fast and without network.
/**
 * @param {Page} page
 * @param {boolean} cdn
 * @returns {Promise<string[]>} the page errors, collected while the test runs
 */
async function guard(page, cdn) {
  if (!cdn) await page.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, (route) => route.abort());
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

// `otherPage` is a second tab in the same browser context, so it shares the storage of `page`.
/** @type {import('@playwright/test').Fixtures<{ cdn: boolean, otherPage: Page }, Record<never, never>, TestArgs, WorkerArgs>} */
const fixtures = {
  cdn: [false, { option: true }],
  page: async ({ page, cdn }, use) => {
    const errors = await guard(page, cdn);
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
  },
  otherPage: async ({ context, cdn }, use) => {
    const page = await context.newPage();
    const errors = await guard(page, cdn);
    await use(page);
    expect(errors, 'uncaught page errors in the other tab').toEqual([]);
  },
};
export const test = base.extend(fixtures);

export { expect };
