/**
 * Devanagari → Latin transliteration, for slugs (#24).
 *
 * Deliberately lossy and ASCII-only: this exists so इन्द्रजात्रा becomes
 * `indrajatra` in a URL, not so it can be reversed. Long and short vowels
 * collapse (ि and ी are both `i`), retroflex and dental collapse (ट and त are
 * both `t`), because a slug is read by people typing it and by search engines,
 * neither of which benefits from diacritics.
 *
 * Nepali spelling conventions are followed where they differ from Hindi
 * romanisation: व is `w` (Waah, not Vaah) and ऋ is `ri`.
 */

const INDEPENDENT_VOWELS: Record<string, string> = {
  'अ': 'a',  'आ': 'a',  'इ': 'i',  'ई': 'i',
  'उ': 'u',  'ऊ': 'u',  'ऋ': 'ri', 'ॠ': 'ri',
  'ए': 'e',  'ऐ': 'ai', 'ओ': 'o',  'औ': 'au',
  'ऍ': 'e',  'ऑ': 'o',
}

/** Bare consonant sounds — the inherent 'a' is added by the walker, not here. */
const CONSONANTS: Record<string, string> = {
  'क': 'k',  'ख': 'kh', 'ग': 'g',  'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh','ज': 'j',  'झ': 'jh', 'ञ': 'ny',
  'ट': 't',  'ठ': 'th', 'ड': 'd',  'ढ': 'dh', 'ण': 'n',
  'त': 't',  'थ': 'th', 'द': 'd',  'ध': 'dh', 'न': 'n',
  'प': 'p',  'फ': 'ph', 'ब': 'b',  'भ': 'bh', 'म': 'm',
  'य': 'y',  'र': 'r',  'ल': 'l',  'ळ': 'l',  'व': 'w',
  'श': 'sh', 'ष': 'sh', 'स': 's',  'ह': 'h',
  // Nukta forms, which appear in loanwords.
  'क़': 'k',  'ख़': 'kh', 'ग़': 'g',  'ज़': 'z',
  'ड़': 'r',  'ढ़': 'rh', 'फ़': 'f',  'य़': 'y',
}

const MATRAS: Record<string, string> = {
  'ा': 'a',  'ि': 'i',  'ी': 'i',  'ु': 'u',
  'ू': 'u',  'ृ': 'ri', 'े': 'e',  'ै': 'ai',
  'ो': 'o',  'ौ': 'au', 'ॅ': 'e',  'ॉ': 'o',
}

const VIRAMA = '्'
const SIGNS: Record<string, string> = {
  'ँ': 'n', // chandrabindu
  'ं': 'n', // anusvara
  'ः': 'h', // visarga
  '़': '',  // nukta — already folded into the consonant map
  'ऽ': '',  // avagraha
  '।': ' ', // danda
  '॥': ' ',
}

const DIGIT_ZERO = 0x0966

/**
 * Two cases where the word-final inherent vowel survives:
 *   - a one-letter word — र is "ra" (and), not a bare "r"
 *   - after a conjunct — इन्द्र is "indra", not "indr", because a cluster
 *     cannot end a syllable
 */
function keepsFinalSchwa(input: string, index: number): boolean {
  const previous = input[index - 1]
  if (previous === undefined) return true
  if (previous === VIRAMA) return true
  return !isDevanagariLetter(previous)
}

function isDevanagariLetter(ch: string): boolean {
  return (
    CONSONANTS[ch] !== undefined ||
    INDEPENDENT_VOWELS[ch] !== undefined ||
    MATRAS[ch] !== undefined ||
    ch === VIRAMA ||
    (SIGNS[ch] !== undefined && ch !== '।' && ch !== '॥')
  )
}

/** True when the consonant at `index` ends a Devanagari word. */
function isWordFinal(input: string, index: number): boolean {
  const next = input[index + 1]
  if (next === undefined) return true
  return !isDevanagariLetter(next)
}

export function hasDevanagari(input: string): boolean {
  return /[ऀ-ॿ]/.test(input)
}

export function transliterateDevanagari(input: string): string {
  let out = ''

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string

    const consonant = CONSONANTS[ch]
    if (consonant !== undefined) {
      out += consonant
      // A consonant carries an inherent 'a' unless a matra replaces it or a
      // virama kills it. This is the whole reason a lookup table is not enough.
      const next = input[i + 1]
      if (next === VIRAMA) {
        i++
      } else if (next !== undefined && MATRAS[next] !== undefined) {
        out += MATRAS[next]
        i++
      } else if (!isWordFinal(input, i) || keepsFinalSchwa(input, i)) {
        out += 'a'
      }
      // Word-final schwa deletion: नेपाल is Nepal, not Nepala. Nepali and Hindi
      // both drop the inherent vowel at the end of a word, and a slug that
      // keeps it reads as a misspelling to the people searching for it.
      continue
    }

    const vowel = INDEPENDENT_VOWELS[ch]
    if (vowel !== undefined) { out += vowel; continue }

    const sign = SIGNS[ch]
    if (sign !== undefined) { out += sign; continue }

    // A matra reached on its own is malformed input; ignore it rather than throw.
    if (MATRAS[ch] !== undefined || ch === VIRAMA) continue

    const code = ch.codePointAt(0) ?? 0
    if (code >= DIGIT_ZERO && code <= DIGIT_ZERO + 9) {
      out += String(code - DIGIT_ZERO)
      continue
    }

    out += ch
  }

  return out
}
