// Where globalSetup renders the reports, and the shared test fixture every spec imports.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { test as base, expect } from '@playwright/test';

export const REPORTS = join(tmpdir(), 'review-report-e2e');

// file:// URL of a rendered report: 'single.html', or a page of the paged one such as 'paged/chapter-02.html'.
export function reportUrl(name) {
  const path = name.startsWith('paged/') ? join(REPORTS, 'paged', name.slice('paged/'.length)) : join(REPORTS, name);
  return pathToFileURL(path).href;
}

// Every test fails on an uncaught page error, so a broken page script never passes quietly.
// CDN requests are blocked unless a test opts in with test.use({ cdn: true }): the page must work
// without highlight.js and Mermaid, and the other tests then run fast and without network.
export const test = base.extend({
  cdn: [false, { option: true }],
  page: async ({ page, cdn }, use) => {
    if (!cdn) await page.route(/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/, (route) => route.abort());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
  },
});

export { expect };
