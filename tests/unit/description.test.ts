import { describe, expect, it } from 'vitest'
import { inlines, parseDescription } from '../../app/lib/description'

/**
 * #43 — the description is rendered in the shape the author typed. The
 * fixtures are the shapes the imports actually produce.
 */
const text = (line: string) => ({ kind: 'text', text: line })
const plain = (line: string) => [text(line)]

describe('paragraphs', () => {
  it('splits on blank lines and keeps single line breaks inside a paragraph', () => {
    expect(parseDescription('Join us!\n\n📅 Date: Friday\n⏰ Time: 7pm\n📍 Venue: Paalo')).toEqual([
      { kind: 'paragraph', lines: [plain('Join us!')] },
      { kind: 'paragraph', lines: [plain('📅 Date: Friday'), plain('⏰ Time: 7pm'), plain('📍 Venue: Paalo')] },
    ])
  })

  it('treats Windows line endings as line endings', () => {
    expect(parseDescription('One.\r\n\r\nTwo.')).toEqual([
      { kind: 'paragraph', lines: [plain('One.')] },
      { kind: 'paragraph', lines: [plain('Two.')] },
    ])
  })

  it('drops the column of full stops Instagram captions carry', () => {
    expect(parseDescription('Tonight.\n.\n.\n.\n#music #live')).toEqual([
      { kind: 'paragraph', lines: [plain('Tonight.')] },
      { kind: 'paragraph', lines: [plain('#music #live')] },
    ])
  })

  it('trims surrounding whitespace and swallows runs of blank lines', () => {
    expect(parseDescription('\n\n  Hello  \n\n\n\nWorld\n')).toEqual([
      { kind: 'paragraph', lines: [plain('Hello')] },
      { kind: 'paragraph', lines: [plain('World')] },
    ])
  })

  it('returns nothing for nothing', () => {
    expect(parseDescription('')).toEqual([])
    expect(parseDescription('\n \n')).toEqual([])
  })
})

describe('lists', () => {
  it('turns dashed lines into a list, with the heading line before it kept as a paragraph', () => {
    expect(parseDescription('WHAT TO BRING:\n- Paints\n- Brushes\n• A canvas')).toEqual([
      { kind: 'paragraph', lines: [plain('WHAT TO BRING:')] },
      { kind: 'list', ordered: false, items: [plain('Paints'), plain('Brushes'), plain('A canvas')] },
    ])
  })

  it('turns numbered steps into an ordered list', () => {
    expect(parseDescription('1. DM us\n2) Donate\n3. Email your receipt')).toEqual([
      { kind: 'list', ordered: true, items: [plain('DM us'), plain('Donate'), plain('Email your receipt')] },
    ])
  })

  it('does not mistake a year or a time for a step', () => {
    expect(parseDescription('2026 is the year\n10:00 AM start\n1.500 rupees')).toEqual([
      { kind: 'paragraph', lines: [plain('2026 is the year'), plain('10:00 AM start'), plain('1.500 rupees')] },
    ])
  })

  it('does not mistake a dash inside a sentence, or a bare dash, for a bullet', () => {
    expect(parseDescription('Doors open - 7pm\n-\n-Not a bullet')).toEqual([
      { kind: 'paragraph', lines: [plain('Doors open - 7pm')] },
      { kind: 'paragraph', lines: [plain('-Not a bullet')] },
    ])
  })

  it('ends a list at the next plain line and at a change of marker', () => {
    expect(parseDescription('- one\n- two\nThen:\n1. first\n2. second\n- loose')).toEqual([
      { kind: 'list', ordered: false, items: [plain('one'), plain('two')] },
      { kind: 'paragraph', lines: [plain('Then:')] },
      { kind: 'list', ordered: true, items: [plain('first'), plain('second')] },
      { kind: 'list', ordered: false, items: [plain('loose')] },
    ])
  })
})

describe('links', () => {
  it('links a bare URL and leaves the sentence’s punctuation outside it', () => {
    expect(inlines('Register at https://events.mlh.com/events/14872-bharatpur.')).toEqual([
      text('Register at '),
      { kind: 'link', href: 'https://events.mlh.com/events/14872-bharatpur', text: 'https://events.mlh.com/events/14872-bharatpur' },
      text('.'),
    ])
  })

  it('links an email address', () => {
    expect(inlines('Email johnnyprixx@gmail.com (full name).')).toEqual([
      text('Email '),
      { kind: 'link', href: 'mailto:johnnyprixx@gmail.com', text: 'johnnyprixx@gmail.com' },
      text(' (full name).'),
    ])
  })

  it('does not link www. without a scheme, or an @handle', () => {
    expect(inlines('by @wibo_arte at www.example.com')).toEqual([text('by @wibo_arte at www.example.com')])
  })

  it('keeps an address inside a URL as part of the URL', () => {
    expect(inlines('https://x.test/?to=a@b.co now')).toEqual([
      { kind: 'link', href: 'https://x.test/?to=a@b.co', text: 'https://x.test/?to=a@b.co' },
      text(' now'),
    ])
  })

  it('links inside list items too', () => {
    expect(parseDescription('- Donate at https://pmdrf.nchl.com.np/ - keep the receipt')).toEqual([
      { kind: 'list', ordered: false, items: [[
        text('Donate at '),
        { kind: 'link', href: 'https://pmdrf.nchl.com.np/', text: 'https://pmdrf.nchl.com.np/' },
        text(' - keep the receipt'),
      ]] },
    ])
  })
})
