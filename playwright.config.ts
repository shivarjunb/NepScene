import { defineConfig, devices } from '@playwright/test'

/**
 * Browser checks for the criteria that only a browser can settle (#16, #17,
 * #18): keyboard operability, focus trapping, theme on first paint, and no
 * horizontal scroll from 320px to 2560px.
 *
 * These run against the built SPA on Vite's preview server. They are separate
 * from the Vitest suite, which runs in workerd and never touches a DOM.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
