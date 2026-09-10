import { fold } from '../lib/fold'
import { withinDistance } from '../lib/editDistance'

/**
 * The same place, spelled every way people actually spell it (#42, #46).
 *
 * Nepali place names reach a Latin keyboard through no agreed romanisation, so
 * one place arrives as four or five strings: Pokhara and Pokhra, Birgunj and
 * Birganj, Nepalgunj and Nepalganj. Add the Devanagari spelling and the local
 * name that is not a transliteration of the official one at all — Yala for
 * Lalitpur, Khwopa for Bhaktapur, Yen for Kathmandu — and a search that
 * matches strings finds a fraction of what is there.
 *
 * This is a curated table rather than a phonetic algorithm on purpose. The
 * hard cases are not phonetic: nothing derives "Patan" from "Lalitpur", and a
 * soundex-style scheme that got Pokhra right would also collapse names that
 * are genuinely different. Twenty-odd groups covers where events happen; the
 * fuzzy pass below covers the misspellings the table does not enumerate.
 *
 * **Every variant is indexed by its folded form**, which is what makes the two
 * directions in #46's acceptance criteria one mechanism rather than two:
 * `काठमाडौं` folds to `kathmadaun`, which is in the Kathmandu group, so a
 * Devanagari query expands to the Latin spellings — and a Latin query expands
 * to the Devanagari one, which is what finds a listing titled in Devanagari.
 */
type AliasGroup = {
  /** How the place is written when NepScene has to name it. */
  canonical: string
  /** Every spelling that means it, in either script. */
  variants: string[]
}

export const ALIAS_GROUPS: AliasGroup[] = [
  { canonical: 'Kathmandu', variants: ['Kathmandu', 'Ktm', 'Katmandu', 'Kathmandoo', 'Kathmandu Valley', 'Kantipur', 'Yen', 'काठमाडौं', 'काठमाण्डौ', 'कान्तिपुर'] },
  { canonical: 'Lalitpur', variants: ['Lalitpur', 'Patan', 'Yala', 'ललितपुर', 'पाटन'] },
  { canonical: 'Bhaktapur', variants: ['Bhaktapur', 'Bhadgaon', 'Khwopa', 'भक्तपुर', 'भादगाउँ'] },
  { canonical: 'Kirtipur', variants: ['Kirtipur', 'कीर्तिपुर'] },
  { canonical: 'Pokhara', variants: ['Pokhara', 'Pokhra', 'Pokahra', 'Pokharaa', 'पोखरा'] },
  { canonical: 'Chitwan', variants: ['Chitwan', 'Bharatpur', 'Sauraha', 'चितवन', 'भरतपुर', 'सौराहा'] },
  { canonical: 'Biratnagar', variants: ['Biratnagar', 'Birat Nagar', 'विराटनगर'] },
  { canonical: 'Birgunj', variants: ['Birgunj', 'Birganj', 'Veerganj', 'वीरगञ्ज', 'बीरगञ्ज'] },
  { canonical: 'Dharan', variants: ['Dharan', 'धरान'] },
  { canonical: 'Butwal', variants: ['Butwal', 'Butawal', 'बुटवल'] },
  { canonical: 'Nepalgunj', variants: ['Nepalgunj', 'Nepalganj', 'नेपालगञ्ज'] },
  { canonical: 'Dhangadhi', variants: ['Dhangadhi', 'Dhangadi', 'धनगढी'] },
  { canonical: 'Janakpur', variants: ['Janakpur', 'Janakpurdham', 'जनकपुर'] },
  { canonical: 'Hetauda', variants: ['Hetauda', 'Hetaunda', 'हेटौंडा'] },
  { canonical: 'Itahari', variants: ['Itahari', 'इटहरी'] },
  { canonical: 'Damak', variants: ['Damak', 'दमक'] },
  { canonical: 'Lumbini', variants: ['Lumbini', 'Rupandehi', 'लुम्बिनी', 'रुपन्देही'] },
  { canonical: 'Bandipur', variants: ['Bandipur', 'बन्दिपुर'] },
  { canonical: 'Ilam', variants: ['Ilam', 'इलाम'] },
  { canonical: 'Namche', variants: ['Namche', 'Namche Bazaar', 'Solukhumbu', 'नाम्चे', 'सोलुखुम्बु'] },
  { canonical: 'Mustang', variants: ['Mustang', 'Jomsom', 'मुस्ताङ', 'जोमसोम'] },
  { canonical: 'Nuwakot', variants: ['Nuwakot', 'नुवाकोट'] },
  // Neighbourhoods. People search for these far more than for the city that
  // contains them — "Thamel" is a more useful query than "Kathmandu".
  { canonical: 'Thamel', variants: ['Thamel', 'ठमेल'] },
  { canonical: 'Lakeside', variants: ['Lakeside', 'Baidam', 'लेकसाइड', 'बैदाम'] },
  { canonical: 'Durbarmarg', variants: ['Durbarmarg', 'Durbar Marg', 'दरबारमार्ग'] },
  { canonical: 'Jhamsikhel', variants: ['Jhamsikhel', 'Jhamel', 'झम्सिखेल'] },
  { canonical: 'Pulchowk', variants: ['Pulchowk', 'पुल्चोक'] },
  { canonical: 'Boudha', variants: ['Boudha', 'Bouddha', 'Boudhanath', 'बौद्ध', 'बौद्धनाथ'] },
  { canonical: 'Basantapur', variants: ['Basantapur', 'Durbar Square', 'बसन्तपुर', 'दरबार क्षेत्र'] },
  // Not places, but the same problem: the word somebody types is not the word
  // the catalogue stores. Categories carry a Nepali name of their own, so this
  // only needs the colloquialisms.
  { canonical: 'Concert', variants: ['Concert', 'Gig', 'Live Music', 'कन्सर्ट', 'सङ्गीत', 'संगीत'] },
  { canonical: 'Festival', variants: ['Festival', 'Jatra', 'Parva', 'चाडपर्व', 'जात्रा', 'पर्व'] },
  { canonical: 'Comedy', variants: ['Comedy', 'Standup', 'Stand Up', 'हास्य', 'कमेडी'] },
  { canonical: 'Free', variants: ['Free', 'Nishulka', 'निःशुल्क', 'नि:शुल्क'] },
]

/** Folded variant → the group it belongs to. Built once, read on every query. */
const INDEX = new Map<string, AliasGroup>()
for (const group of ALIAS_GROUPS) {
  for (const variant of group.variants) {
    const key = fold(variant)
    if (key) INDEX.set(key, group)
  }
}

/** Every folded key, for the fuzzy pass. */
const KEYS = [...INDEX.keys()]

/** Below this, an edit is as likely to change the word as to fix it. */
const MIN_FUZZY_LENGTH = 5

export type AliasMatch = {
  group: AliasGroup
  /** 0 when the term was already a known spelling. */
  distance: number
}

/**
 * The group a term belongs to, allowing up to `maxEdits` slips.
 *
 * The exact hit is tried first and separately: "Damak" must not be corrected
 * to "Damak"-adjacent anything just because a nearer-looking key exists. Only
 * a term nothing recognises is allowed to be fuzzy.
 */
export function resolveAlias(term: string, maxEdits = 0): AliasMatch | null {
  const exact = INDEX.get(term)
  if (exact) return { group: exact, distance: 0 }
  if (maxEdits <= 0) return null

  // Short words are not fuzzy-matched, in either direction: at four letters
  // two edits reaches most of the table, and "Ilam" would answer for "Islam".
  // The budget also scales with length — one slip is plausible in a six-letter
  // word, two is a different word.
  if (term.length < MIN_FUZZY_LENGTH) return null
  const budget = term.length >= 8 ? maxEdits : Math.min(maxEdits, 1)

  let best: AliasMatch | null = null
  for (const key of KEYS) {
    if (key.length < MIN_FUZZY_LENGTH) continue
    const distance = withinDistance(term, key, budget)
    if (distance === null) continue
    if (!best || distance < best.distance) {
      best = { group: INDEX.get(key)!, distance }
      if (distance === 1) break
    }
  }
  return best
}

/**
 * Every spelling a term should be searched for, itself included.
 *
 * Returned raw rather than folded, because they are matched against columns
 * that hold raw text: the Devanagari variants only find a Devanagari title if
 * they are still in Devanagari when they reach the LIKE.
 */
export function expandTerm(term: string, maxEdits = 0): string[] {
  const match = resolveAlias(term, maxEdits)
  if (!match) return [term]
  const spellings = new Set<string>([term])
  for (const variant of match.group.variants) {
    spellings.add(variant)
    // The folded form as well: "Durbar Marg" is stored without the space in
    // some rows and with it in others, and both should match.
    const folded = fold(variant)
    if (folded) spellings.add(folded)
  }
  return [...spellings]
}
