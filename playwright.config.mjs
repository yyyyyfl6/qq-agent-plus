import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT } from './test/browser/constants.mjs';

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 900 }
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: `http://127.0.0.1:${E2E_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ]
});
