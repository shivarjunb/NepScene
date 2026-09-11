import { defineConfig, devices } from '@playwright/test'

/**
 * Browser checks for the criteria that only a browser can settle (#16, #17,
 * #18): keyboard operability, focus trapping, theme on first paint, and no
 * horizontal scroll from 320px to 2560px.
 *
 * Most of these run against the built SPA on Vite's preview server, with the
 * catalogue stubbed at the network boundary — which is right when the subject
 * is the client.
 *
 * Server rendering (#45) cannot be tested that way: the preview server serves
 * the static shell and renders nothing, so a test of it there would pass while
 * proving nothing. `tests/e2e/rendering.spec.ts` runs against the real Worker
 * on the second server below, reading the seeded local D1.
 *
 * They are separate from the Vitest suite, which runs in workerd and never
 * touches a DOM.
 */
const WORKER_PORT = 8788
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  // Creates the two accounts the journey specs sign in as, with a password
  // generated per run so none is ever committed. See the file for why the
  // journeys use real auth rather than the stub every other spec uses.
  globalSetup: './tests/e2e/globalSetup.ts',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  /**
   * Four projects (#48).
   *
   * The audience is overwhelmingly Android Chrome with meaningful iOS Safari
   * usage, and Safari is where the map, geolocation and theme handling most
   * often diverge — so testing only Chromium tests the browser this repository
   * was developed in and nothing else.
   *
   * The cost is real, so it is not spent evenly. Chromium runs everything;
   * WebKit, Firefox and the mobile viewport run `journeys.spec.ts` only, which
   * is the four journeys carrying most of the product's value. A rendering
   * detail that differs in Firefox and breaks no journey is not worth three
   * times the suite duration to find.
   */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: /journeys\.spec\.ts/,
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /journeys\.spec\.ts/,
    },
    {
      // A real phone profile, not a narrow desktop window: `hasTouch` is what
      // makes `tap()` work and what the map's `gestureHandling: 'cooperative'`
      // behaves differently under.
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      testMatch: /journeys\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      url: 'http://localhost:4173',
      // Keyless by construction, not by accident. Two specs assert the no-key
      // state directly — `map.spec.ts`'s "no map key at all" and
      // `venuePicker.spec.ts`'s typed-coordinate fallback — and they read the
      // built bundle, so they passed only because no key existed anywhere.
      // A developer's `.env.local` or a provisioned CI secret would have
      // started loading the real SDK and failed both. An inline VITE_ variable
      // takes precedence over `.env` files in Vite, and `mapsApiKey()` reads
      // empty as absent, so this pins the fixture whatever the environment
      // holds. Every other map spec installs its own SDK stub and does not
      // care either way.
      env: { VITE_GOOGLE_MAPS_API_KEY: '' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The real Worker, against the local D1 the demo seed populates. The
      // build is shared with the preview server above; `wrangler dev` serves
      // `dist/client` as its assets, so it needs no build of its own.
      command: `npx wrangler dev --port ${WORKER_PORT} --local`,
      url: `http://localhost:${WORKER_PORT}/robots.txt`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
