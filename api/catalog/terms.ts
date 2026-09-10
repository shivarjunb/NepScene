import { fold, tokenise, words } from '../lib/fold'
import { withinDistance } from '../lib/editDistance'
import { expandTerm } from './aliases'

/**
 * A query, turned into something SQL can match and the ranker can score (#42).
 *
 * The shape is one entry per word the person typed, each carrying every
 * spelling that word should be looked for under. Retrieval ANDs the words and
 * ORs the spellings: "thamel jazz" means both words, either script, any known
 * variant of either.
 */
export type SearchTerm = {
  /** The folded word as typed — what the ranker compares against. */
  token: string
  /** Every spelling to match, raw, including the Devanagari ones. */
  patterns: string[]
}

/**
 * Four words is where a query stops being a search and starts being a
 * sentence, and every extra word multiplies the retrieval SQL. Beyond this the
 * tail is dropped rather than the query refused — the first four words carry
 * the intent.
 */
export const MAX_TERMS = 4
/**
 * Caps the OR-list per word. Not a taste decision: D1 allows a hundred bound
 * variables per statement (api/catalog/queries.ts), and four words at eight
 * spellings is thirty-two of them, which leaves room for every filter a search
 * can also carry. Kathmandu is the widest group in the table at ten spellings,
 * so this trims two — the two least likely to be typed, since the list is
 * ordered with the common spellings first.
 */
const MAX_PATTERNS = 8

export function parseTerms(raw: string, { maxEdits = 0 } = {}): SearchTerm[] {
  return words(raw)
    .slice(0, MAX_TERMS)
    .map(({ raw: typed, folded }) => ({
      token: folded,
      // The word as typed comes first and is always searched for. Folding is
      // what lets a Devanagari query reach the alias table; keeping the
      // original is what lets it reach a Devanagari column (#46).
      patterns: [...new Set([typed, ...expandTerm(folded, maxEdits)])].slice(0, MAX_PATTERNS),
    }))
}

/**
 * The vocabulary a misspelling is corrected against: every word that actually
 * appears somewhere in the catalogue.
 *
 * Correcting against the catalogue rather than against a dictionary is what
 * makes this work for a corpus of proper nouns. "Kutumba" is not a word, and
 * no spell checker would leave it alone — but it is a band with listings, so
 * it is in here, and "Kutumbaa" resolves to it.
 */
export function vocabularyWords(labels: string[]): Set<string> {
  const words = new Set<string>()
  for (const label of labels) {
    for (const word of fold(label).split(' ')) {
      if (word.length >= 3) words.add(word)
    }
  }
  return words
}

export type Correction = {
  /** The query as it should be re-run. */
  query: string
  /** What was changed, for "showing results for …". Null when nothing was. */
  from: string | null
}

/**
 * One correction pass over a query that found nothing.
 *
 * Only words the catalogue has never seen are touched — a word that occurs
 * somewhere is spelled the way somebody meant to spell it, even if it looks
 * like a near-miss of a more common one. Distance one is tried across the
 * whole vocabulary before distance two is tried at all, so a single slip is
 * never out-voted by a two-slip word that happens to be checked first.
 */
export function correct(raw: string, vocabulary: Set<string>): Correction {
  const tokens = tokenise(raw)
  if (tokens.length === 0) return { query: raw, from: null }

  let changed = false
  const corrected = tokens.map((token) => {
    if (vocabulary.has(token)) return token
    if (token.length < 4) return token
    const replacement = nearest(token, vocabulary)
    if (!replacement) return token
    changed = true
    return replacement
  })

  return changed
    ? { query: corrected.join(' '), from: raw }
    : { query: raw, from: null }
}

const MAX_EDITS = 2

function nearest(token: string, vocabulary: Set<string>): string | null {
  let best: { word: string; distance: number } | null = null
  for (const word of vocabulary) {
    const distance = withinDistance(token, word, MAX_EDITS)
    if (distance === null) continue
    if (!best || distance < best.distance) {
      best = { word, distance }
      if (distance === 1) break
    }
  }
  return best?.word ?? null
}
