import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import type { Env as AppEnv } from '../api/env'

/**
 * `cloudflare:test` types its env as `Cloudflare.Env`. Extending it here means
 * tests get the same bindings the Worker declares, plus the migrations the
 * setup file applies.
 */
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}

export {}
