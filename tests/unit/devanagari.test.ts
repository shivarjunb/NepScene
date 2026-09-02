import { describe, expect, it } from 'vitest'
import { hasDevanagari, transliterateDevanagari } from '../../api/lib/devanagari'
import { slugify } from '../../api/lib/slug'

describe('transliterateDevanagari', () => {
  it('resolves conjuncts through the virama', () => {
    // इन्द्रजात्रा: न् and त् lose their inherent vowel, र keeps its matra.
    expect(transliterateDevanagari('इन्द्रजात्रा')).toBe('indrajatra')
  })

  it('applies matras instead of the inherent vowel', () => {
    expect(transliterateDevanagari('पोखरा')).toBe('pokhara')
    expect(transliterateDevanagari('माघे')).toBe('maghe')
  })

  it('deletes the word-final schwa, as Nepali does', () => {
    expect(transliterateDevanagari('नेपाल')).toBe('nepal')
    expect(transliterateDevanagari('नाटक')).toBe('natak')
  })

  it('keeps the schwa after a conjunct, which cannot end a syllable', () => {
    // इन्द्र is Indra, not Indr — the न्द् cluster needs the vowel after it.
    expect(transliterateDevanagari('इन्द्र')).toBe('indra')
    expect(transliterateDevanagari('क्षेत्र')).toBe('kshetra')
  })

  it('keeps the vowel in a one-letter word', () => {
    // र means "and". A bare "r" is not a word.
    expect(transliterateDevanagari('कला र नाटक')).toBe('kala ra natak')
  })

  it('renders anusvara as n', () => {
    expect(transliterateDevanagari('संक्रान्ति')).toBe('sankranti')
    expect(transliterateDevanagari('दशैं')).toBe('dashain')
  })

  it('converts Devanagari digits', () => {
    expect(transliterateDevanagari('२०८२')).toBe('2082')
  })

  it('leaves Latin text alone', () => {
    expect(transliterateDevanagari('Kathmandu 2026')).toBe('Kathmandu 2026')
  })
})

describe('hasDevanagari', () => {
  it('detects the script without being fooled by Latin', () => {
    expect(hasDevanagari('इन्द्रजात्रा')).toBe(true)
    expect(hasDevanagari('Indra Jatra')).toBe(false)
    expect(hasDevanagari('Indra जात्रा')).toBe(true)
  })
})

describe('slugify with Devanagari', () => {
  it('produces a sensible Latin slug, not an empty one', () => {
    expect(slugify('इन्द्रजात्रा')).toBe('indrajatra')
    expect(slugify('माघे संक्रान्ति')).toBe('maghe-sankranti')
    expect(slugify('पाटन संग्रहालय')).toBe('patan-sangrahalay')
    expect(slugify('इन्द्र जात्रा')).toBe('indra-jatra')
  })

  it('handles a mixed-script title', () => {
    expect(slugify('Jazzmandu जाज महोत्सव')).toBe('jazzmandu-jaj-mahotsaw')
  })
})
