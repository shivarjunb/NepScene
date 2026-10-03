export type Env = {
  DB: D1Database
  SETTINGS: KVNamespace
  MEDIA: R2Bucket
  ASSETS: Fetcher
  ENVIRONMENT: 'local' | 'preview' | 'staging' | 'production'
  /**
   * WaahTickets' Offer API. Empty everywhere until there is a hand-off worth
   * making (docs/BACKLOG.md, deliberately deferred). Offers currently render
   * from the snapshot stored on the listing — the public read path makes no
   * external network hop (docs/ARCHITECTURE.md, rule 1).
   */
  OFFER_API_URL: string
  /**
   * Google sign-in (#27). Both empty disables the Google routes rather than
   * failing them — a preview environment without credentials still runs.
   * The secret is set with `wrangler secret put`, never in wrangler.jsonc.
   */
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  /**
   * The scrape runs (migration 0015). The console starts one by dispatching
   * the `daily-scrape.yml` workflow in GITHUB_REPOSITORY with a fine-grained
   * token that can do nothing but that (`actions: write` on this repository);
   * the runner reports back to /api/internal with SCRAPE_REPORT_TOKEN. Both
   * tokens are secrets; either missing disables its half with a 503 rather
   * than failing it, so a preview without them still runs.
   */
  GITHUB_REPOSITORY: string
  GITHUB_DISPATCH_TOKEN?: string
  SCRAPE_REPORT_TOKEN?: string
  /**
   * Staging only: what deploy-staging.yml's last step presents to
   * /api/internal/staging-deploys, to have a green commit promoted when the
   * console's "promote automatically" is on. Its own secret, not the scrape
   * runner's, so neither job's token opens the other's routes. Missing → 503,
   * and the staging deploy carries on without it.
   */
  DEPLOY_CALLBACK_TOKEN?: string
}
