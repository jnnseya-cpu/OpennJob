import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: the extension, and the built API process. `npm run test:e2e` builds everything first.
 * Chromium comes from PLAYWRIGHT_BROWSERS_PATH (pre-installed); this repo pins
 * @playwright/test to the version that matches that browser build, so do not run
 * `playwright install` here. To use a different Chromium, set OPENNJOB_CHROMIUM_PATH.
 */
export default defineConfig({
  // apps/extension/test/e2e: the extension in Chromium. apps/api/test/e2e: the built API as a real process.
  testDir: 'apps',
  testMatch: '**/test/e2e/**/*.spec.ts',
  outputDir: 'test-results',
  reporter: [['list']],
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  timeout: 30_000,
  use: {
    headless: true,
    launchOptions: process.env.OPENNJOB_CHROMIUM_PATH ? { executablePath: process.env.OPENNJOB_CHROMIUM_PATH } : {},
  },
});
