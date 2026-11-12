// @ts-check
// Playwright globalSetup: renders the reports into a fresh folder of this run's own and names it in the
// environment, where the workers and globalTeardown find it.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderReports } from './render-reports.mjs';
import { REPORTS_ENV } from './reports.mjs';

/** Renders the reports into a new temporary folder and exports its path. */
export default function globalSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'review-report-e2e-'));
  process.env[REPORTS_ENV] = dir;
  renderReports(dir);
}
