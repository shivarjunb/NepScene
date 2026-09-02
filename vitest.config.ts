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
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['api/**/*.ts'],
      // Route composition and wire types have no behaviour to cover.
      exclude: ['api/catalog/routes.ts', 'api/catalog/types.ts', 'api/env.ts'],
    },
  },
})
