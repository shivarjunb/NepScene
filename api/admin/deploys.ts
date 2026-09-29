import { Hono } from 'hono'
import type { Env } from '../env'
import { auditStatement } from '../lib/audit'
import { ApiError, badRequest, notFound } from '../lib/http'
import { requirePermission, type AuthVariables } from '../identity/middleware'
import { notConfigured } from '../scrapes/runs'
import { dispatchWorkflow } from './scrapes'

/**
 * "Deploy to production", from the staging console (`/api/admin/system/deploy`).
 *
 * Staging is where a commit is looked at before it is promoted, so staging is
 * the only console with the button: everywhere else these routes are 404 and
 * the card does not render. The button does what a person used to do by hand
 * — find the newest commit that deployed to staging, name the deploy after
 * what it brings in, and start `deploy-production.yml` — and nothing more.
 * The workflow's own gate still checks the commit went green on staging, and
 * a reviewer still approves it in GitHub: the dispatch token can start a
 * deploy, never approve one, so a leaked token cannot ship anything alone.
 * The workflow @mentions the reviewers when it reaches that gate.
 *
 * It needs no new secret: GITHUB_DISPATCH_TOKEN is already "Actions: read and
 * write" on this repository, which covers listing both workflows' runs and
 * dispatching one.
 */
export const adminDeployRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>()

const STAGING = 'deploy-staging.yml'
const PRODUCTION = 'deploy-production.yml'
const SHA = /\b[0-9a-f]{40}\b/
/** Statuses GitHub gives a run that has not finished; `waiting` is the approval gate. */
const ACTIVE = ['queued', 'in_progress', 'waiting', 'requested', 'pending']

type WorkflowRun = {
  id: number
  head_sha: string
  status: string
  conclusion: string | null
  display_title: string
  html_url: string
  created_at: string
  head_commit?: { message?: string } | null
}

export type Commit = { sha: string; title: string; deployed_at: string; run_url: string }
export type ProductionRun = { sha: string | null; title: string; status: string; conclusion: string | null; url: string; created_at: string }

async function runs(env: Env, workflow: string, query: string, fetcher: typeof fetch): Promise<WorkflowRun[]> {
  const response = await fetcher(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs?${query}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        'user-agent': 'nepscene-admin',
        'x-github-api-version': '2022-11-28',
      },
    },
  )
  if (!response.ok) throw new ApiError(502, 'github_unavailable', `GitHub answered HTTP ${response.status} for ${workflow}`)
  return ((await response.json()) as { workflow_runs?: WorkflowRun[] }).workflow_runs ?? []
}

/**
 * The deploy's name: what the new commits say they are. A squash merge's
 * first line is the PR's title and number, which is exactly what someone
 * reading the production history wants to see.
 */
export function defaultReason(commits: Commit[]): string {
  if (!commits.length) return ''
  const titles = commits.map((c) => c.title)
  const joined = titles.join('; ')
  if (joined.length <= 200) return joined
  return `${titles.length} changes: ${titles[0]!.slice(0, 150)}; and ${titles.length - 1} more`
}

/**
 * Where staging is, where production is, and what lies between. Production's
 * commit comes from the run's title (`run-name` in deploy-production.yml):
 * a dispatched run's own head is main at the moment of dispatch, not the
 * commit it deployed.
 */
export async function deployState(env: Env, fetcher: typeof fetch = fetch) {
  const [staging, production] = await Promise.all([
    runs(env, STAGING, 'status=success&per_page=30', fetcher),
    runs(env, PRODUCTION, 'per_page=10', fetcher),
  ])
  const recent: ProductionRun[] = production.map((r) => ({
    sha: r.display_title.match(SHA)?.[0] ?? null, title: r.display_title,
    status: r.status, conclusion: r.conclusion, url: r.html_url, created_at: r.created_at,
  }))
  const live = recent.find((r) => r.status === 'completed' && r.conclusion === 'success' && r.sha) ?? null
  const commits: Commit[] = []
  for (const r of staging) {
    if (commits.some((c) => c.sha === r.head_sha)) continue
    commits.push({ sha: r.head_sha, title: (r.head_commit?.message ?? '').split('\n')[0]!.trim() || r.display_title, deployed_at: r.created_at, run_url: r.html_url })
  }
  // Newest first; everything before production's commit is what a promotion
  // would add. When production's commit is not among the recent staging runs
  // (older, or deployed before runs carried their SHA), only the newest is
  // offered, since the rest cannot be told apart from what is already live.
  const liveAt = live ? commits.findIndex((c) => c.sha === live.sha) : -1
  const ahead = liveAt >= 0 ? commits.slice(0, liveAt) : commits.slice(0, 1)
  const candidate = ahead[0] ?? null
  return {
    production: live && { sha: live.sha, deployed_at: live.created_at, url: live.url },
    candidate,
    ahead,
    reason: defaultReason(ahead),
    active: recent.find((r) => ACTIVE.includes(r.status)) ?? null,
    recent: recent.slice(0, 5),
  }
}

function stagingOnly(env: Env) {
  if (env.ENVIRONMENT !== 'staging') throw notFound('Production deploys start from the staging console')
  if (!env.GITHUB_DISPATCH_TOKEN) throw notConfigured('Deploying to production')
}

adminDeployRoutes.get('/system/deploy', requirePermission('user:manage'), async (c) => {
  stagingOnly(c.env)
  return c.json(await deployState(c.env))
})

adminDeployRoutes.post('/system/deploy', requirePermission('user:manage'), async (c) => {
  stagingOnly(c.env)
  const body = await c.req.json<{ sha?: unknown; reason?: unknown }>().catch(() => { throw badRequest('invalid_json', 'Send a JSON body') })
  const sha = typeof body?.sha === 'string' ? body.sha.trim().toLowerCase() : ''
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : ''
  if (!/^[0-9a-f]{40}$/.test(sha)) throw badRequest('invalid_field', 'sha must be a full 40-character commit SHA')
  if (!reason) throw badRequest('invalid_field', 'Say why you are deploying')
  if (reason.length > 300) throw badRequest('invalid_field', 'Keep the reason under 300 characters')

  const state = await deployState(c.env)
  // Only what the workflow's gate would let through, refused here before it
  // costs a run: a commit staging deployed successfully, and one at a time —
  // the workflow's concurrency group would only queue a second behind the first.
  if (state.active) throw new ApiError(409, 'already_deploying', `A production deploy is already ${state.active.status}: ${state.active.url}`)
  if (!state.ahead.some((commit) => commit.sha === sha)) {
    throw new ApiError(409, 'not_on_staging', 'That commit is not a recent successful staging deploy that production is missing')
  }

  const dispatched = await dispatchWorkflow(c.env, { sha, reason }, fetch, PRODUCTION)
  if (!dispatched.ok) throw new ApiError(502, 'dispatch_failed', dispatched.error)

  const actor = c.get('user')
  await auditStatement(c.env, {
    entityType: 'listing', entityId: 'deploy', action: 'production_deploy_requested',
    actorId: actor.id, actorRole: actor.role, details: { sha, reason },
  }).run()
  return c.json({ sha, reason, actions_url: `https://github.com/${c.env.GITHUB_REPOSITORY}/actions/workflows/${PRODUCTION}` }, 202)
})
