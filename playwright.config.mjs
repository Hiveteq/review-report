// @ts-check
// Browser tests for the report page script, in the three engines a reviewer might use.
// Reports are opened from file:// URLs, as a reviewer opens them; globalSetup renders them first.
import { defineConfig, devices } from '@playwright/test';

const ci = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/render-reports.mjs',
  fullyParallel: true,
  forbidOnly: ci,
  retries: 0, // a flaky test is a bug to fix, not to retry
  reporter: ci ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    // Wide enough for margin notes, which need a file block of at least 900px.
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1440, height: 900 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1440, height: 900 } } },
  ],
});
