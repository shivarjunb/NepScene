/**
 * Slugs (#24). A published URL is a promise, so slugs are ASCII, lowercase and
 * stable. Devanagari titles do not transliterate here — they fall back to the
 * caller's prefix plus a suffix, which is why `uniqueSlug` takes a fallback.
 */
const MAX_SLUG_LENGTH = 80

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip the combining accents NFKD just split off
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
}

/**
 * Appends -2, -3 … until the slug is free. `exists` is injected so this stays
 * pure and testable; the caller supplies the table it is checking.
 */
export async function uniqueSlug(
  desired: string,
  exists: (candidate: string) => Promise<boolean>,
  fallback = 'listing',
): Promise<string> {
  const base = slugify(desired) || fallback
  if (!(await exists(base))) return base
  for (let n = 2; n <= 50; n++) {
    const candidate = `${base.slice(0, MAX_SLUG_LENGTH - 4)}-${n}`
    if (!(await exists(candidate))) return candidate
  }
  return `${base.slice(0, MAX_SLUG_LENGTH - 9)}-${crypto.randomUUID().slice(0, 8)}`
}
