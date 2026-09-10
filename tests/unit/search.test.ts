import { describe, expect, it } from 'vitest'
import { fold, tokenise } from '../../api/lib/fold'
import { withinDistance } from '../../api/lib/editDistance'
import { ALIAS_GROUPS, expandTerm, resolveAlias } from '../../api/catalog/aliases'
import { correct, parseTerms, vocabularyWords } from '../../api/catalog/terms'
import { suggest, toFacets, alternativesFor } from '../../api/catalog/search'
import { whenBuckets } from '../../api/catalog/when'

/**
 * #42's unit plan: alias resolution across the Nepali city variants, typo
 * tolerance at edit distance one and two, and facet shaping.
 */

describe('folding', () => {
  it('is the same string for every way of writing a name', () => {
    expect(fold('Kathmandu')).toBe('kathmandu')
    expect(fold('KATHMANDU')).toBe('kathmandu')
    expect(fold('Kāthmāndū')).toBe('kathmandu')
  })

  it('transliterates Devanagari rather than dropping it', () => {
    expect(fold('पोखरा')).toBe('pokhara')
    expect(fold('ठमेल')).toBe('thamel')
  })

  it('keeps words apart, unlike a slug', () => {
    expect(tokenise('Jazz at the House')).toEqual(['jazz', 'house'])
  })

  it('still searches for something when the query is all stop words', () => {
    expect(tokenise('the')).toEqual(['the'])
  })
})

describe('edit distance', () => {
  it('counts a substitution, an insertion and a deletion as one', () => {
    expect(withinDistance('kathmandu', 'kathmandi', 2)).toBe(1)
    expect(withinDistance('kathmandu', 'kathmandut', 2)).toBe(1)
    expect(withinDistance('kathmandu', 'kathmand', 2)).toBe(1)
  })

  it('counts two adjacent letters swapped as one, not two', () => {
    // The commonest phone-keyboard slip there is.
    expect(withinDistance('kathmandu', 'kahtmandu', 2)).toBe(1)
  })

  it('refuses anything past the budget rather than reporting how far', () => {
    expect(withinDistance('kathmandu', 'pokhara', 2)).toBeNull()
    expect(withinDistance('kathmandu', 'kthmndu', 1)).toBeNull()
    expect(withinDistance('kathmandu', 'kthmndu', 2)).toBe(2)
  })
})

describe('Nepali place-name aliases', () => {
  it('covers at least twenty places', () => {
    expect(ALIAS_GROUPS.length).toBeGreaterThanOrEqual(20)
  })

  it('resolves every spelling of Kathmandu to one group', () => {
    const canonical = ['kathmandu', 'ktm', 'katmandu', 'kantipur', 'yen']
      .map((spelling) => resolveAlias(spelling)?.group.canonical)
    expect(new Set(canonical)).toEqual(new Set(['Kathmandu']))
  })

  it('bridges the two scripts in both directions', () => {
    // Devanagari in: it folds to a transliteration that is in the table.
    expect(resolveAlias(fold('काठमाडौं'))?.group.canonical).toBe('Kathmandu')
    // Latin in: the expansion carries the Devanagari spelling back out, which
    // is what finds a listing whose title is written in Devanagari (#46).
    expect(expandTerm('kathmandu')).toContain('काठमाडौं')
  })

  it('knows the local names that are not transliterations at all', () => {
    expect(resolveAlias('patan')?.group.canonical).toBe('Lalitpur')
    expect(resolveAlias('khwopa')?.group.canonical).toBe('Bhaktapur')
    expect(resolveAlias('yala')?.group.canonical).toBe('Lalitpur')
  })

  it('accepts a misspelling only when asked to be fuzzy', () => {
    expect(resolveAlias('kathmndu')).toBeNull()
    expect(resolveAlias('kathmndu', 2)?.group.canonical).toBe('Kathmandu')
  })

  it('does not fuzzy-match a short word into a different place', () => {
    // Four letters and two edits reaches half the table.
    expect(resolveAlias('ilam', 2)?.group.canonical).toBe('Ilam')
    expect(resolveAlias('islam', 2)?.group.canonical).not.toBe('Ilam')
  })

  it('caps the spellings per word so the SQL stays inside D1s limits', () => {
    expect(parseTerms('kathmandu')[0]?.patterns.length).toBeLessThanOrEqual(8)
  })
})

describe('correcting a query against the catalogue', () => {
  const vocabulary = vocabularyWords([
    'Kutumba at Purple Haze', 'Lakeside Live', 'Pokhara', 'Kathmandu', 'Thamel',
  ])

  it('leaves a word the catalogue actually contains alone', () => {
    expect(correct('kutumba', vocabulary).from).toBeNull()
  })

  it('fixes one slip', () => {
    expect(correct('kutumbaa', vocabulary).query).toBe('kutumba')
  })

  it('fixes two', () => {
    expect(correct('kutamboa', vocabulary).query).toBe('kutumba')
  })

  it('reports what was typed, so the page can offer it back', () => {
    expect(correct('lakesyde', vocabulary).from).toBe('lakesyde')
  })

  it('gives up rather than inventing a match', () => {
    expect(correct('zzzzzzzz', vocabulary).from).toBeNull()
  })
})

const vocabulary = [
  { kind: 'listing' as const, slug: 'rock-night', label: 'Rock Night', weight: 3 },
  { kind: 'venue' as const, slug: 'purple-haze', label: 'Purple Haze', weight: 2 },
  { kind: 'city' as const, slug: 'kathmandu', label: 'Kathmandu', weight: 2 },
  { kind: 'category' as const, slug: 'concerts', label: 'Concerts', weight: 1 },
]

describe('suggestions', () => {
  it('prefers a prefix hit to one buried in the middle', () => {
    expect(suggest('roc', vocabulary)[0]?.label).toBe('Rock Night')
  })

  it('matches the start of any word, not only the first', () => {
    expect(suggest('haze', vocabulary).map((s) => s.label)).toContain('Purple Haze')
  })

  it('tolerates a slip once the word is long enough to be sure about', () => {
    expect(suggest('kathmandi', vocabulary).map((s) => s.label)).toContain('Kathmandu')
  })

  it('offers the broadest entry points when the query resembles nothing', () => {
    const alternatives = alternativesFor('zzzzzzz', vocabulary)
    expect(alternatives.length).toBeGreaterThan(0)
    expect(alternatives.every((entry) => entry.kind === 'category' || entry.kind === 'city')).toBe(true)
  })
})

describe('facets', () => {
  const buckets = whenBuckets(new Date('2026-09-10T06:00:00Z'))

  it('splits the flat union into its four groups', () => {
    const facets = toFacets([
      { facet: 'city', value: 'Kathmandu', label: 'Kathmandu', label_ne: null, count: 4 },
      { facet: 'category', value: 'concerts', label: 'Concerts', label_ne: null, count: 3 },
      { facet: 'price', value: 'free', label: 'free', label_ne: null, count: 1 },
      { facet: 'when', value: 'today', label: 'today', label_ne: null, count: 2 },
    ], buckets)

    expect(facets.city).toHaveLength(1)
    expect(facets.category[0]?.label).toBe('Concerts')
    // The raw band is a SQL value; the label is what a chip says.
    expect(facets.price[0]?.label).toBe('Free')
  })

  it('carries the window a date facet was counted over, so the chip and the filter agree', () => {
    const facets = toFacets([{ facet: 'when', value: 'today', label: 'today', label_ne: null, count: 2 }], buckets)
    expect(facets.when[0]?.to).toBe(buckets[0]?.to)
  })

  it('orders dates as a timeline rather than by size', () => {
    const facets = toFacets([
      { facet: 'when', value: 'later', label: 'later', label_ne: null, count: 40 },
      { facet: 'when', value: 'today', label: 'today', label_ne: null, count: 1 },
    ], buckets)
    expect(facets.when.map((entry) => entry.value)).toEqual(['today', 'later'])
  })

  it('drops a row it does not recognise rather than failing the search', () => {
    const facets = toFacets(
      [{ facet: 'nonsense' as never, value: 'x', label: 'x', label_ne: null, count: 1 }], buckets,
    )
    expect(facets.city).toEqual([])
  })
})

describe('date buckets', () => {
  it('are cumulative, so a listing falls in exactly one', () => {
    const buckets = whenBuckets(new Date('2026-09-08T06:00:00Z'))
    for (let index = 1; index < buckets.length; index++) {
      expect(buckets[index]?.from).toBe(buckets[index - 1]?.to)
    }
  })

  it('leave the first open at the start, so something still running is today', () => {
    expect(whenBuckets(new Date('2026-09-08T06:00:00Z'))[0]?.from).toBeNull()
  })

  it('end the week on Saturday, which is Nepals weekly holiday', () => {
    // Thursday 10 September 2026 in Kathmandu.
    const week = whenBuckets(new Date('2026-09-10T06:00:00Z'))
      .find((bucket) => bucket.value === 'this-week')
    // Midnight after Saturday the 12th, in Kathmandu, is 18:15Z on the 12th.
    expect(week?.to).toBe('2026-09-12T18:15:00.000Z')
  })

  it('drop a bucket that could never have a count', () => {
    // On a Friday, "this week" ends when "tomorrow" does.
    const values = whenBuckets(new Date('2026-09-11T06:00:00Z')).map((bucket) => bucket.value)
    expect(values).not.toContain('this-week')
  })

  it('re-link the chain after a collapse, so a chip counts what it links to', () => {
    // The facet SQL buckets a row by the first `to` it falls before, so a
    // surviving bucket that kept a dropped neighbour's `from` would count one
    // window and filter by another.
    for (const day of ['2026-09-11', '2026-09-12', '2026-09-29', '2026-09-30', '2026-10-01']) {
      const buckets = whenBuckets(new Date(`${day}T06:00:00Z`))
      expect(buckets[0]?.from, day).toBeNull()
      for (let index = 1; index < buckets.length; index++) {
        expect(buckets[index]?.from, `${day} #${index}`).toBe(buckets[index - 1]?.to)
      }
      expect(buckets.at(-1)?.to, day).toBeNull()
    }
  })
})

/**
 * The banded DP's first column, which is where the band nearly ate a real
 * alignment: cell (i, 0) is "delete the first i characters", and clearing the
 * out-of-band cells before setting it made every match that starts with an
 * inserted letter cost one edit too many.
 *
 * Checked against a plain unbanded Damerau-Levenshtein rather than against
 * hand-picked pairs, because the failures were only visible in bulk.
 */
function reference(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1
      let cell = Math.min(
        (d[i - 1]![j] as number) + 1,
        (d[i]![j - 1] as number) + 1,
        (d[i - 1]![j - 1] as number) + substitution,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cell = Math.min(cell, (d[i - 2]![j - 2] as number) + 1)
      }
      d[i]![j] = cell
    }
  }
  return d[a.length]![b.length] as number
}

describe('the banded distance agrees with an unbanded one', () => {
  it('over every short string on a three-letter alphabet', () => {
    const alphabet = ['a', 'b', 'c']
    const words: string[] = ['']
    for (let length = 1; length <= 4; length++) {
      const previous = words.filter((word) => word.length === length - 1)
      for (const word of previous) for (const letter of alphabet) words.push(word + letter)
    }

    const disagreements: string[] = []
    for (const a of words) {
      for (const b of words) {
        for (const budget of [1, 2]) {
          const exact = reference(a, b)
          const banded = withinDistance(a, b, budget)
          const expected = exact <= budget ? exact : null
          if (banded !== expected) disagreements.push(`${a}/${b}@${budget}: ${banded} ≠ ${expected}`)
        }
      }
    }
    expect(disagreements.slice(0, 5)).toEqual([])
  })

  it('matches a word with a letter stuck on the front', () => {
    expect(withinDistance('okathmandu', 'kathmandu', 1)).toBe(1)
    expect(withinDistance('nnjazz', 'jazz', 2)).toBe(2)
  })
})
