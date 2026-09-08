import { slugify } from '../lib/slug'

/**
 * Tags are the open half of the taxonomy (#22). Categories are seeded, closed
 * and validated against a table; tags are whatever an author types.
 *
 * "Free-form" is not the same as "unnormalised". `Open Mic`, `open mic` and
 * `Open-Mic` are one tag, because a browse page split three ways across
 * spellings is worse than no browse page. Normalising through the same slug
 * rules as URLs also means a tag is always safe to put in one — including the
 * Devanagari ones, which transliterate rather than vanish.
 */
export const MAX_TAGS_PER_LISTING = 12
const MAX_TAG_LENGTH = 40

export function normaliseTag(raw: string): string | null {
  const slug = slugify(raw.trim()).slice(0, MAX_TAG_LENGTH).replace(/-+$/g, '')
  return slug || null
}

/** Slug plus the spelling to show. Order is preserved; duplicates collapse. */
export function normaliseTags(raw: readonly string[]): { slug: string; label: string }[] {
  const seen = new Map<string, { slug: string; label: string }>()
  for (const value of raw) {
    const slug = normaliseTag(value)
    if (!slug || seen.has(slug)) continue
    seen.set(slug, { slug, label: value.trim().slice(0, MAX_TAG_LENGTH) })
    if (seen.size === MAX_TAGS_PER_LISTING) break
  }
  return [...seen.values()]
}
