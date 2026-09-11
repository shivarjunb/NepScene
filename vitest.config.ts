import path from 'node:path'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

// Integration tests run against a real Worker and a real (local) D1, built by
// applying the same migrations production gets. Nothing here mocks the database:
// the WaahTickets audit found three critical defects that only a real
// request-to-database test would have caught.
const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))

// The token layer is asserted against WCAG contrast in tests/unit/contrast.test.ts.
// Tests run in workerd, which has no filesystem, so the stylesheet is injected
// here the same way the migrations are.
const sheet = (name: string) =>
  readFileSync(path.join(import.meta.dirname, 'app/styles', name), 'utf8')

const tokensCss = sheet('tokens.css')
const componentsCss = sheet('components.css')
const baseCss = sheet('base.css')
const shellCss = sheet('shell.css')
const authorCss = sheet('author.css')
const mapCss = sheet('map.css')

export default defineConfig({
  // The same seam wrangler declares (wrangler.jsonc `alias`) and TypeScript
  // declares (api/render/ssr.d.ts): three resolvers, one target. Without this
  // the integration tests exercise the fallback path — a page that failed to
  // render and served the plain shell — while reporting success.
  resolve: {
    alias: { '#ssr': path.join(import.meta.dirname, 'app/server.tsx') },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          TOKENS_CSS: tokensCss,
          COMPONENTS_CSS: componentsCss,
          BASE_CSS: baseCss,
          SHELL_CSS: shellCss,
          AUTHOR_CSS: authorCss,
          MAP_CSS: mapCss,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./tests/setup.ts'],
    // *.test.ts runs here in workerd; *.spec.ts is Playwright's, in a browser.
    include: ['tests/**/*.test.ts'],
    coverage: {
      // Istanbul, not v8: the v8 provider cannot instrument code executing
      // inside workerd, and silently reports 0% for every file the integration
      // tests actually exercise. Instrumentation happens at transform time here,
      // which survives the trip into the workers pool.
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportOnFailure: true,
      include: ['api/**/*.ts'],
      // Route composition and wire types have no behaviour to cover.
      exclude: ['api/catalog/routes.ts', 'api/catalog/types.ts', 'api/env.ts'],
      /**
       * Thresholds weighted by risk (#47), not one number for everything.
       *
       * The principle is the audit's finding about WaahTickets: 100 unit
       * tests, 17 files, and not one of them touching the order lifecycle —
       * which is where all three critical defects lived. A single global
       * threshold lets exactly that happen, because presentation code is easy
       * to cover and subsidises the part nobody wants to test.
       *
       * So the risky directories carry higher bars than the global one. For
       * NepScene the risk is: the catalogue read path (every public page is
       * built from it), the authoring write path (the only place untrusted
       * input becomes a row), and identity (the only place a permission
       * decision is made).
       *
       * Every number is the measured floor rounded down, so it fails on a
       * regression rather than aspiring. When coverage rises, raise them with
       * it (docs/DEVOPS.md).
       */
      thresholds: {
        statements: 94,
        branches: 81,
        functions: 97,
        lines: 96,

        // The read path behind every public page.
        'api/catalog/**': {
          statements: 95, branches: 84, functions: 97, lines: 96,
        },
        // Where untrusted input becomes a row. `validate.ts` lives here.
        'api/author/**': {
          statements: 93, branches: 84, functions: 96, lines: 96,
        },
        // Where every permission decision is made.
        'api/identity/**': {
          statements: 93, branches: 75, functions: 98, lines: 95,
        },
        // Server rendering: a failure here is a blank page for a crawler,
        // which is invisible to everyone who already has the JavaScript.
        'api/render/**': {
          statements: 96, branches: 85, functions: 94, lines: 98,
        },
      },
    },
  },
})
