import { request, type Account } from './author'

/**
 * The browser's half of the admin console's API (#28). Same transport as the
 * authoring client — the session cookie, the typed `AuthorError` — because it
 * is the same session and the same error shape; only the questions differ.
 */

export type Role = Account['role']
export const ROLES: Role[] = ['visitor', 'organizer', 'editor', 'admin']

export type Page = { limit: number; offset: number; has_more: boolean }

const query = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const encoded = search.toString()
  return encoded ? `?${encoded}` : ''
}

// ── Overview ────────────────────────────────────────────────────────────────

export type Overview = {
  users: Record<Role, { total: number; inactive: number }>
  listings: Record<string, number>
  organizations: { total: number; verified: number }
  recent: AuditEntry[]
}

export const fetchOverview = () => request<Overview>('/api/admin/overview')

// ── Users ───────────────────────────────────────────────────────────────────

export type AdminUser = {
  id: string
  email: string
  name: string | null
  role: Role
  is_active: boolean
  email_verified: boolean
  has_password: boolean
  has_google: boolean
  last_login_at: string | null
  created_at: string
  listing_count: number
  organization_count: number
}

export type UserList = { data: AdminUser[]; counts: Record<Role, number>; page: Page }

export const fetchUsers = (params: { q?: string; role?: Role; offset?: number; limit?: number }) =>
  request<UserList>(`/api/admin/users${query(params)}`)

export const updateUser = (id: string, change: { role?: Role; is_active?: boolean }) =>
  request<AdminUser>(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(change),
  })

// ── Organizations ───────────────────────────────────────────────────────────

export type AdminOrganization = {
  id: string
  slug: string
  name: string
  contact_email: string | null
  website_url: string | null
  is_verified: boolean
  created_at: string
  member_count: number
  listing_count: number
  published_count: number
}

export type OrgRole = 'owner' | 'manager' | 'member'
export const ORG_ROLES: OrgRole[] = ['owner', 'manager', 'member']

export type Member = {
  user_id: string
  email: string
  name: string | null
  role: Role
  org_role: OrgRole
  is_active: boolean
  since: string
}

export type OrganizationList = { data: AdminOrganization[]; page: Page }
export type OrganizationDetail = AdminOrganization & { members: Member[] }

export const fetchOrganizations = (params: { q?: string; offset?: number; limit?: number }) =>
  request<OrganizationList>(`/api/admin/organizations${query(params)}`)

export const fetchOrganization = (id: string) =>
  request<OrganizationDetail>(`/api/admin/organizations/${encodeURIComponent(id)}`)

export const setVerified = (id: string, verified: boolean) =>
  request<{ id: string; is_verified: boolean }>(`/api/admin/organizations/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ is_verified: verified }),
  })

export const setMember = (id: string, email: string, orgRole: OrgRole) =>
  request<{ members: Member[] }>(`/api/admin/organizations/${encodeURIComponent(id)}/members`, {
    method: 'PUT', body: JSON.stringify({ email, org_role: orgRole }),
  })

export const removeMember = (id: string, userId: string) =>
  request<{ members: Member[] }>(
    `/api/admin/organizations/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )

// ── Audit ───────────────────────────────────────────────────────────────────

export type EntityType = 'listing' | 'venue' | 'organization' | 'user' | 'media'
export const ENTITY_TYPES: EntityType[] = ['listing', 'venue', 'organization', 'user', 'media']

export type AuditEntry = {
  id: string
  entity_type: EntityType
  entity_id: string
  entity_label: string | null
  entity_slug: string | null
  action: string
  actor: { id: string; email: string | null; role: string | null } | null
  details: Record<string, unknown> | null
  created_at: string
}

export type AuditList = { data: AuditEntry[]; page: Page }

export const fetchAudit = (params: {
  entity_type?: EntityType; entity_id?: string; actor_id?: string; offset?: number; limit?: number
}) => request<AuditList>(`/api/admin/audit${query(params)}`)

// ── Housekeeping ────────────────────────────────────────────────────────────

export const runArchive = () =>
  request<{ archived: number; scanned: number }>('/api/admin/system/archive', { method: 'POST' })

export type Sweep = { scanned: number; orphans: number; deleted: number; dry_run: boolean; keys: string[] }

/** Lives under the authoring API because that is where uploads live. */
export const sweepMedia = (dryRun: boolean) =>
  request<Sweep>(`/api/author/media/sweep?dry_run=${dryRun}`, { method: 'POST' })

// ── Scrape runs ─────────────────────────────────────────────────────────────

export type ScrapeJob = {
  name: string
  success: boolean
  skipped?: boolean
  exit_code: number | null
  error: string | null
  import?: { new_drafts?: number; duplicates?: number; excluded?: number } | null
}

export type ScrapeRun = {
  id: string
  trigger: 'schedule' | 'manual'
  requested_by: string | null
  requested_by_name: string | null
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  apply_env: 'preview' | 'staging' | 'production' | null
  github_run_url: string | null
  summary: { complete: boolean; jobs: ScrapeJob[] } | null
  drafts_created: number
  output_key: string | null
  error: string | null
  requested_at: string
  started_at: string | null
  finished_at: string | null
}

export type ScrapeRuns = { data: ScrapeRun[]; pending_imports: number; configured: boolean }

export const fetchScrapeRuns = () => request<ScrapeRuns>('/api/admin/system/scrape-runs')

export const startScrapeRun = () =>
  request<ScrapeRun>('/api/admin/system/scrape', { method: 'POST' })

export const scrapeOutputUrl = (id: string) =>
  `/api/admin/system/scrape-runs/${encodeURIComponent(id)}/output`
