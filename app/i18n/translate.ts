import { STRINGS, type Language, type StringKey } from './strings'

/**
 * `{placeholders}` are substituted rather than concatenated, because word
 * order is not the same in the two languages: "In Kathmandu" is "काठमाडौंमा",
 * where the preposition is a suffix on the noun. A template with a slot can
 * express that; `'In ' + city` cannot.
 */
export function translate(
  key: StringKey, language: Language, values?: Record<string, string | number>,
): string {
  const entry = STRINGS[key]
  const template = entry[language] || entry.en
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole)
}
