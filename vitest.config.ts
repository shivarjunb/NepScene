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

export default defineConfig({
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
      // Ratcheted to the measured floor. A drop fails the build; when coverage
      // rises, raise these with it (docs/DEVOPS.md).
      thresholds: {
        statements: 91,
        branches: 74,
        functions: 97,
        lines: 94,
      },
    },
  },
})
