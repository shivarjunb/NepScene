import { Hono } from 'hono'
import type { Env } from '../env'
import { ApiError, badRequest } from '../lib/http'
import {
  AUTO_PREFIX, STAGING, autoPromote, defaultReason, deployState, requestProductionDeploy, stagingOnly, workflowRun,
} from '../admin/deploys'
import { runnerToken } from './token'

/**
 * Staging's deploy, reporting that it went green (`/api/internal/staging-deploys`).
 *
 * The last step of deploy-staging.yml, after the smoke test, posts the commit
 * and its own run id here. With "promote automatically" off this does
 * nothing. With it on, it starts the same production deploy the console's
 * button would (api/admin/deploys.ts), named "Auto: …", which then waits for
 * a reviewer in GitHub like any other. The token can start a deploy, never
 * approve one.
 *
 * Its own token, DEPLOY_CALLBACK_TOKEN, rather than the scrape runner's: that
 * one lives in the `scrape` environment, on a job that fetches and parses
 * other people's websites, and is scoped to a ledger that "touches no
 * listing". Starting a production deploy is a different kind of power, and
 * the staging job — whose environment holds the deploy credentials already —
 * is the only thing that needs it.
 *
 * The race. The run that calls is still running, so GitHub does not list it
 * among the successful staging runs yet. Rather than trust the SHA in the
 * body, this asks GitHub for the calling run by id and counts it as green
 * only if it is a deploy-staging.yml run of that very commit, on main, that
 * has not concluded any other way. A leaked token can therefore only
 * nominate a commit staging is actually deploying from main — and the
 * workflow's gate waits for that run to conclude `success` before anything
 * reaches the approval step.
 */
export const internalDeployRoutes = new Hono<{ Bindings: Env }>()

/**
 * The answers that mean "decided not to", not "something broke": the step
 * that calls is best-effort either way, but these are the normal life of a
 * switch that is on, and a 200 keeps them out of the run's failure log.
 */
const DECLINED = ['already_deploying', 'not_on_staging', 'not_this_run']

// Scoped to its route, not `use('*')`: this router and the scrape runner's
// share the /api/internal prefix, and each token opens only its own routes.
internalDeployRoutes.post(
  '/staging-deploys',
  runnerToken((env) => env.DEPLOY_CALLBACK_TOKEN, 'Promoting staging deploys'),
  async (c) => {
    stagingOnly(c.env)
    const body = await c.req.json<{ sha?: unknown; run_id?: unknown }>().catch(() => { throw badRequest('invalid_json', 'Send a JSON body') })
    const sha = typeof body?.sha === 'string' ? body.sha.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{40}$/.test(sha)) throw badRequest('invalid_field', 'sha must be a full 40-character commit SHA')
    if (!Number.isInteger(body.run_id) || (body.run_id as number) <= 0) throw badRequest('invalid_field', 'run_id is the calling run\'s github.run_id')
    const runId = body.run_id as number

    if (!(await autoPromote(c.env))) return c.json({ promoted: false, reason: 'disabled' })

    try {
      const run = await workflowRun(c.env, runId)
      const finishedBadly = run.status === 'completed' && run.conclusion !== 'success'
      if (!run.path?.split('@')[0]!.endsWith(`/${STAGING}`) || run.head_sha !== sha || run.head_branch !== 'main' || finishedBadly) {
        throw new ApiError(409, 'not_this_run', `Run ${runId} is not a green ${STAGING} run of ${sha} on main`)
      }
      const state = await deployState(c.env, fetch, run)
      // Named after what this commit brings in, from itself down to
      // production — not after anything newer, which it would not deploy.
      const at = state.ahead.findIndex((commit) => commit.sha === sha)
      const reason = `${AUTO_PREFIX}${defaultReason(at >= 0 ? state.ahead.slice(at) : [])}`.slice(0, 300)
      const started = await requestProductionDeploy(c.env, state, sha, reason, { kind: 'automatic', stagingRun: runId })
      return c.json({ promoted: true, ...started }, 202)
    } catch (caught) {
      if (caught instanceof ApiError && DECLINED.includes(caught.code)) {
        return c.json({ promoted: false, reason: caught.code, message: caught.message })
      }
      throw caught
    }
  },
)
