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
}
