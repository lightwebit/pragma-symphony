import { defineConfig, devices } from '@playwright/experimental-ct-vue'

// Component testing for the Vue frontend — mounts real .vue components (e.g. ReviewCard)
// with a controllable Pinia store, no Tauri runtime involved. See ../../.docs/2026-07-24_test-code-review_model-assignment.md §8.10.
export default defineConfig({
  testDir: './tests',
  snapshotDir: './__snapshots__',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
    ctPort: 3100,
    ctTemplateDir: '.',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
})
