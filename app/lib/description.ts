/**
 * The shape of an author's description, recovered from plain text.
 *
 * Descriptions arrive as whatever the author typed into a form, or whatever an
 * import found on a page: Windows line endings, one fact per line ("📅 Date",
 * "⏰ Time", "📍 Venue"), dashed bullets, numbered steps, a bare URL to
 * register at, and the Instagram habit of a column of lone full stops before
 * the hashtags. Rendered as one paragraph per blank line — which is what the
 * listing page did — all of that collapses into a single block of text, and a
 * `\r\n\r\n` does not even count as a blank line.
 *
 * This is deliberately not Markdown. Authors did not write Markdown, and a
 * parser that treats `*` as emphasis would mangle the plain text of anyone
 * who used it as a bullet. It recognises exactly the conventions found in the
 * catalogue and passes everything else through as the lines it was.
 */
export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'link'; href: string; text: string }

/** One line of a paragraph or one item of a list, already linkified. */
export type Line = Inline[]

export type Block =
  | { kind: 'paragraph'; lines: Line[] }
  | { kind: 'list'; ordered: boolean; items: Line[] }

const BULLET = /^\s*[-*•▪◦●–—]\s+(.*)$/
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/

/**
 * A line with nothing on it but punctuation. Instagram captions carry a column
 * of these to push the hashtags below the fold; a horizontal rule of dashes is
 * the same thing typed on purpose. Neither reads as anything on a page.
 */
const FILLER = /^[\s.\-_~*=•·]*$/

/**
 * Only http(s) is linked. A bare `www.` is not linked — guessing a scheme is
 * how a typo becomes a link to nowhere — and nothing else is a URL at all.
 * Trailing punctuation is the sentence's, not the address's.
 */
const URL = /https?:\/\/[^\s<>"'`]+/g
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g
const TRAILING = /[.,;:!?)\]}'"]+$/

export function parseDescription(raw: string): Block[] {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd())
  const blocks: Block[] = []
  let paragraph: Line[] = []
  let list: { ordered: boolean; items: Line[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', lines: paragraph })
    paragraph = []
  }
  const flushList = () => {
    if (list) blocks.push({ kind: 'list', ...list })
    list = null
  }

  for (const line of lines) {
    if (FILLER.test(line)) {
      // A blank line ends whatever is open; a filler line is treated the same,
      // so a rule of dashes still separates what it was typed to separate.
      flushParagraph()
      flushList()
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const text = (bullet ?? numbered)![1]!.trim()
      flushParagraph()
      // A numbered step after a run of dashes is a different list, not the
      // same one changing its mind.
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push(inlines(text))
      continue
    }

    // Plain text after a list is a new paragraph: the list item does not run
    // on, because a line break inside an item was not what the author typed.
    flushList()
    paragraph.push(inlines(line.trim()))
  }
  flushParagraph()
  flushList()
  return blocks
}

/** Splits a line into text and the links found in it. */
export function inlines(text: string): Line {
  const found: { start: number; end: number; href: string; text: string }[] = []
  for (const match of text.matchAll(URL)) {
    const shown = match[0].replace(TRAILING, '')
    found.push({ start: match.index, end: match.index + shown.length, href: shown, text: shown })
  }
  for (const match of text.matchAll(EMAIL)) {
    const start = match.index
    const end = start + match[0].length
    // An address inside a URL's query string is part of the URL.
    if (found.some((link) => start >= link.start && end <= link.end)) continue
    found.push({ start, end, href: `mailto:${match[0]}`, text: match[0] })
  }
  found.sort((a, b) => a.start - b.start)

  const result: Line = []
  let cursor = 0
  for (const link of found) {
    if (link.start > cursor) result.push({ kind: 'text', text: text.slice(cursor, link.start) })
    result.push({ kind: 'link', href: link.href, text: link.text })
    cursor = link.end
  }
  if (cursor < text.length) result.push({ kind: 'text', text: text.slice(cursor) })
  return result
}
