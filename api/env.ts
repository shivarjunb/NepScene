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
}
