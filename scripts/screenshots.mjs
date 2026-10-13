// @ts-check
// Regenerates the README screenshots from the demo fixture (the Greeter change in test/), never from a real
// project. Needs Playwright's Chromium: `npm ci && npx playwright install chromium`.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// The page.waitForFunction and page.evaluate callbacks below run in the browser, not in Node.
/* global document, window */

const root = fileURLToPath(new URL('..', import.meta.url));
const skill = join(root, 'skills', 'review-report');
const shots = join(root, 'docs', 'screenshots');
const out = mkdtempSync(join(tmpdir(), 'rr-shots-'));
const html = join(out, 'report.html');
const r = spawnSync(process.execPath, [join(skill, 'render.mjs'), '--story', join(skill, 'test', 'fixture.story.json'),
  '--diff-file', join(skill, 'test', 'fixture.diff'), '--single', '--out', html], { encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const settle = async () => { await page.waitForFunction(() => document.querySelector('pre.mermaid svg')); await page.waitForTimeout(300); };

// 1. Light theme, margin notes: overview with its diagram, then the first chapters.
await page.emulateMedia({ colorScheme: 'light' });
await page.goto(pathToFileURL(html).href);
await settle();
await page.screenshot({ path: join(shots, 'report-margin-light.png'), clip: { x: 0, y: 0, width: 1440, height: 1700 }, fullPage: true });

// 2. Hovering an annotated line opens its note under the line.
const greeter = page.locator('section.file[data-path="src/Greeter.java"]');
await greeter.scrollIntoViewIfNeeded();
await greeter.locator('code.hint-target').nth(1).hover();
await page.waitForTimeout(200);
await greeter.screenshot({ path: join(shots, 'hover-hint.png') });

// 3. Dark theme, split diff, one file ticked as viewed, progress in the sidebar.
await page.mouse.move(5, 5);
await page.evaluate(() => { localStorage.clear(); localStorage.setItem('review-report-theme', 'dark'); localStorage.setItem('review-report-diff', 'split'); });
await page.reload();
await settle();
await page.locator('section.file[data-path="src/Name.java"] .viewed-toggle').check();
await page.locator('#chapter-2').scrollIntoViewIfNeeded();
// The fixture report always has a first chapter, so getElementById finds it.
await page.evaluate(() => window.scrollTo(0, /** @type {HTMLElement} */ (document.getElementById('chapter-1')).offsetTop - 20));
await page.screenshot({ path: join(shots, 'report-dark-split.png') });

await browser.close();
rmSync(out, { recursive: true, force: true });
console.log('screenshots written to docs/screenshots');
