import { hasDevanagari, transliterateDevanagari } from './devanagari'

/**
 * One folding of text for search (#42, #46).
 *
 * Everything that is compared — a query, a vocabulary entry, a title being
 * scored — passes through here first, so "Kathmandu", "kathmandu" and
 * "KĀTHMĀNDŪ" are one string and `काठमाडौं` becomes something a Latin
 * keyboard can reach. It is the same lossy transliteration slugs use (#24),
 * for the same reason: a search index that keeps diacritics is a search index
 * nobody can type into.
 *
 * Deliberately *not* the same function as `slugify`. A slug joins words with
 * hyphens because a URL needs one token; search needs the words kept apart so
 * each can be matched, corrected and scored on its own.
 */
export function fold(input: string): string {
  const latin = hasDevanagari(input) ? transliterateDevanagari(input) : input
  return latin
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Apostrophes close up rather than splitting: "what's" is one word.
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Words that carry no signal in a two-or-three word query and would otherwise
 * make every listing a match. Kept short on purpose — an aggressive stop list
 * breaks real titles ("The Vibes", "Live at Purple Haze").
 */
const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'on', 'and', 'to', 'for'])

/** Folded words, in order, with the noise dropped and duplicates collapsed. */
export function tokenise(input: string, { keepStopWords = false } = {}): string[] {
  return words(input, { keepStopWords }).map((word) => word.folded)
}

export type Word = {
  /** As typed, in whatever script it was typed in. */
  raw: string
  /** Folded to lowercase Latin — what is compared, corrected and scored. */
  folded: string
}

/**
 * The words of a query, each kept in both forms.
 *
 * **The raw spelling has to survive**, and this is the whole reason the pair
 * exists rather than a list of folded strings. A Devanagari query folds to
 * Latin so that it can be compared against the alias table and the ranker —
 * but the columns holding Nepali titles are still in Devanagari, and a folded
 * pattern cannot match them. Searching for both spellings is what makes
 * `रक नाइट` find a listing titled `रक नाइट` (#46).
 */
export function words(input: string, { keepStopWords = false } = {}): Word[] {
  // Split on the same separators `fold` collapses, but over the original
  // string, so a Devanagari word comes out of it intact.
  const raws = input.split(/[\s,./\\|;:!?()[\]{}"“”«»–—_+*=<>@#$^~`]+/).filter(Boolean)

  const seen = new Set<string>()
  const out: Word[] = []
  for (const raw of raws) {
    const folded = fold(raw)
    if (!folded) continue
    if (!keepStopWords && STOP_WORDS.has(folded)) continue
    if (seen.has(folded)) continue
    seen.add(folded)
    out.push({ raw, folded })
  }
  // A query that is nothing but stop words ("the") should still search for
  // something rather than returning the whole catalogue.
  if (out.length === 0 && !keepStopWords) return words(input, { keepStopWords: true })
  return out
}
