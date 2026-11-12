// @ts-check
// Playwright globalTeardown: removes the folder globalSetup rendered this run's reports into.
import { rmSync } from 'node:fs';
import { REPORTS_ENV } from './reports.mjs';

/** Deletes the folder that globalSetup created, if it ran. */
export default function globalTeardown() {
  const dir = process.env[REPORTS_ENV];
  // Retries: on Windows a browser can still hold a report file for a moment, and removal fails with EBUSY.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}
