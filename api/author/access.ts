import type { Env } from '../env'
import { ApiError, notFound } from '../lib/http'
import { can, type Role } from '../identity/roles'

/**
 * "May this user edit this listing?" — asked by every author route, so it lives
 * here rather than in whichever of them happened to need it first. Keeping it
 * out of `listings.ts` is also what stops the status verbs and the write
 * endpoints importing each other in a circle.
 */
export type EditableListing = {
  id: string
  slug: string
  status: string
  created_by: string | null
  organization_id: string | null
}

export async function loadEditableListing(
  env: Env, userId: string, role: Role, listingId: string,
): Promise<EditableListing> {
  const listing = await env.DB.prepare(
    'SELECT id, slug, status, created_by, organization_id FROM listings WHERE id = ?1',
  ).bind(listingId).first<EditableListing>()
  if (!listing) throw notFound('No such listing')

  if (can(role, 'listing:edit_any')) return listing
  if (listing.created_by === userId) return listing

  // Organization membership, not ownership: a listing written by a colleague
  // who has since left must stay editable by the organization it belongs to.
  if (listing.organization_id) {
    const membership = await env.DB.prepare(
      'SELECT 1 AS ok FROM organization_users WHERE organization_id = ?1 AND user_id = ?2',
    ).bind(listing.organization_id, userId).first<{ ok: number }>()
    if (membership) return listing
  }

  throw new ApiError(403, 'forbidden', 'That listing belongs to someone else')
}
