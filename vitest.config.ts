import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'

// Integration tests run against a real Worker and a real (local) D1, built by
// applying the same migrations production gets. Nothing here mocks the database:
// the WaahTickets audit found three critical defects that only a real
// request-to-database test would have caught.
const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'))

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['api/**/*.ts'],
      // Route composition and wire types have no behaviour to cover.
      exclude: ['api/catalog/routes.ts', 'api/catalog/types.ts', 'api/env.ts'],
    },
  },
})
