// @ts-check
// Where globalSetup renders the reports, and the shared test fixture every spec imports.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test as base, expect } from '@playwright/test';

/** @typedef {import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions} TestArgs */
/** @typedef {import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions} WorkerArgs */

/**
 * A locator's bounding box. boundingBox() returns null only for an element that is not rendered;
 * the specs read it for elements they have just seen on the page.
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */

export const REPORTS = join(tmpdir(), 'review-report-e2e');

// file:// URL of a rendered report: 'single.html', or a page of the paged one such as 'paged/chapter-02.html'.
/**
 * @param {string} name
 * @returns {string}
 */
export function reportUrl(name) {
  const path = name.startsWith('paged/') ? join(REPORTS, 'paged', name.slice('paged/'.length)) : join(REPORTS, name);
  return pathToFileURL(path).href;
}

// Every test fails on an uncaught page error, so a broken page script never passes quietly.
// CDN requests are blocked unless a test opts in with test.use({ cdn: true }): the page must work
// without highlight.js and Mermaid, and the other tests then run fast and without network.
/** @type {import('@playwright/test').Fixtures<{ cdn: boolean }, {}, TestArgs, WorkerArgs>} */
const fixtures = {
  cdn: [false, { option: true }],
  page: async ({ page, cdn }, use) => {
    if (!cdn) await page.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, (route) => route.abort());
    /** @type {string[]} */
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
  },
};
export const test = base.extend(fixtures);

export { expect };
