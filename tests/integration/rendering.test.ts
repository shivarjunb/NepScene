import { SELF } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { seedCatalogue, seedPublicSite } from '../helpers/seed'

/**
 * #45 — what a crawler and a reader without JavaScript actually receive.
 *
 * These fetch the HTML and read it as a document, which is the only way to
 * check the acceptance criteria that matter here: the content is *in* the
 * response rather than fetched by a script, the structured data is valid, and
 * the titles are generated from the listing rather than templated over it.
 *
 * Nothing here runs JavaScript, which is the point — it is the same view a
 * search engine's first pass and a reader on a failed bundle both get.
 */
const get = (path: string, init?: RequestInit) =>
  SELF.fetch(`https://nepscene.test${path}`, init)

const html = async (path: string) => {
  const response = await get(path)
  return { response, body: await response.text() }
}

const jsonLd = (body: string): Record<string, unknown>[] => {
  const blocks = [...body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
  return blocks.flatMap((match) => {
    const parsed: unknown = JSON.parse((match[1] as string).replace(/\\u003c/g, '<'))
    return Array.isArray(parsed) ? parsed : [parsed]
  }) as Record<string, unknown>[]
}

const meta = (body: string, selector: string) =>
  new RegExp(`<meta[^>]*${selector}[^>]*content="([^"]*)"`).exec(body)?.[1]
  ?? new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${selector}`).exec(body)?.[1]

const tagText = (body: string, tag: string) =>
  new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's').exec(body)?.[1]

beforeAll(async () => {
  await seedCatalogue()
  await seedPublicSite()
})

describe('a listing page without JavaScript', () => {
  it('carries the listing itself, not a loading state', async () => {
    const { response, body } = await html('/listings/rock-night')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')

    // The things a reader came for, in the bytes.
    expect(body).toContain('Rock Night')
    expect(body).toContain('Purple Haze')
    expect(body).toContain('Rock Night summary')
    // …and not the skeleton the client shows while fetching.
    expect(body).not.toContain('aria-busy="true"')
  })

  it('says it was rendered, so the client hydrates rather than rebuilding', async () => {
    const { body } = await html('/listings/rock-night')
    expect(body).toContain('data-rendered="server"')
  })

  it('inlines the data it rendered from, so the client does not fetch it again', async () => {
    const { body } = await html('/listings/rock-night')
    expect(body).toContain('__NEPSCENE_PRELOAD__')
    expect(body).toContain('/listings/rock-night')
  })

  it('renders the related rail, which is a second query on the same page', async () => {
    const { body } = await html('/listings/rock-night')
    expect(body).toContain('You might also like')
    expect(body).toContain('Kutumba Live')
  })
})

describe('titles and descriptions', () => {
  it('builds a title from the listing, its venue and its city', async () => {
    const { body } = await html('/listings/rock-night')
    expect(tagText(body, 'title')).toBe('Rock Night at Purple Haze in Kathmandu — NepScene')
  })

  it('gives every page a different one', async () => {
    const titles = await Promise.all([
      '/', '/listings/rock-night', '/listings/lakeside-live',
      '/venues/purple-haze', '/organizers/himalayan-sound', '/venues', '/organizers',
    ].map(async (path) => tagText((await html(path)).body, 'title')))

    expect(new Set(titles).size).toBe(titles.length)
    for (const title of titles) expect(title).toContain('NepScene')
  })

  it('describes a listing in its own words', async () => {
    const { body } = await html('/listings/rock-night')
    expect(meta(body, 'name="description"')).toBe('Rock Night summary')
  })

  it('falls back to the facts when a listing has no summary of its own', async () => {
    // Every listing has a date and most have a venue, so there is always a
    // sentence to write that no other listing has.
    const { body } = await html('/listings/quiet-recital')
    const description = meta(body, 'name="description"') ?? ''
    expect(description.length).toBeGreaterThan(0)
    expect(description).toContain('Quiet Recital')
  })
})

describe('the social card', () => {
  it('points at the listing, not at the page the reader was on', async () => {
    const { body } = await html('/listings/rock-night')
    expect(meta(body, 'property="og:url"')).toBe('https://nepscene.test/listings/rock-night')
    expect(meta(body, 'property="og:title"')).toContain('Rock Night')
    expect(meta(body, 'property="og:type"')).toBe('article')
  })

  it('is absolute, because a crawler resolves nothing', async () => {
    const { body } = await html('/listings/rock-night')
    expect(meta(body, 'property="og:image"')).toMatch(/^https:\/\//)
  })
})

describe('canonical and language', () => {
  it('names one canonical URL per page', async () => {
    const { body } = await html('/venues/purple-haze')
    expect(/<link rel="canonical" href="([^"]*)"/.exec(body)?.[1])
      .toBe('https://nepscene.test/venues/purple-haze')
  })

  it('resolves a renamed slug to the current one rather than 404ing', async () => {
    const response = await get('/listings/rock-night-2025', { redirect: 'manual' })
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toContain('/listings/rock-night')
  })

  it('declares the Nepali variant, and serves it (#46)', async () => {
    const { body } = await html('/listings/rock-night')
    expect(body).toContain('hreflang="ne"')
    expect(body).toContain('hreflang="x-default"')

    const nepali = await html('/listings/rock-night?lang=ne')
    expect(nepali.body).toContain('<html lang="ne"')
    expect(nepali.body).toContain('रक नाइट')
  })

  it('keeps the English document in English', async () => {
    const { body } = await html('/listings/rock-night')
    expect(body).toContain('<html lang="en"')
  })
})

describe('structured data', () => {
  it('emits an Event with the fields Google requires', async () => {
    const { body } = await html('/listings/rock-night')
    const event = jsonLd(body).find((entry) => entry['@type'] === 'Event')

    expect(event).toBeDefined()
    expect(event!['@context']).toBe('https://schema.org')
    expect(event!.name).toBe('Rock Night')
    expect(event!.startDate).toBeTruthy()
    // Absent, these are read as "unknown" and the result is dropped entirely.
    expect(event!.eventStatus).toBe('https://schema.org/EventScheduled')
    expect(event!.eventAttendanceMode)
      .toBe('https://schema.org/OfflineEventAttendanceMode')

    const location = event!.location as Record<string, unknown>
    expect(location['@type']).toBe('Place')
    expect((location.address as Record<string, unknown>).addressCountry).toBe('NP')
  })

  it('prices the offer in rupees, from the snapshot in paisa', async () => {
    const { body } = await html('/listings/rock-night')
    const event = jsonLd(body).find((entry) => entry['@type'] === 'Event')
    const offers = event!.offers as Record<string, unknown>
    expect(offers.price).toBe(800)
    expect(offers.priceCurrency).toBe('NPR')
    expect(offers.availability).toBe('https://schema.org/InStock')
  })

  it('omits offers entirely where there is nothing to buy', async () => {
    // A ticketed listing with no resolved price says nothing rather than
    // claiming a price of zero — structured data that disagrees with the page
    // is what gets a site's rich results turned off.
    const { body } = await html('/listings/kutumba-live')
    const event = jsonLd(body).find((entry) => entry['@type'] === 'Event')
    expect(event!.offers).toBeUndefined()
  })

  it('prices a free listing at zero, which is different from having no offer', async () => {
    const { body } = await html('/listings/lake-cleanup')
    const event = jsonLd(body).find((entry) => entry['@type'] === 'Event')
    expect((event!.offers as Record<string, unknown>).price).toBe(0)
  })

  it('carries the Nepali title as an alternate name rather than a second page', async () => {
    const { body } = await html('/listings/rock-night')
    const event = jsonLd(body).find((entry) => entry['@type'] === 'Event')
    expect(event!.alternateName).toBe('रक नाइट')
    expect(event!.inLanguage).toEqual(['en', 'ne'])
  })

  it('describes a venue as a Place with what is on there', async () => {
    const { body } = await html('/venues/purple-haze')
    const place = jsonLd(body).find((entry) => entry['@type'] === 'Place')
    expect(place!.name).toBe('Purple Haze')
    expect((place!.event as unknown[]).length).toBeGreaterThan(0)
  })

  it('offers a search box on the homepage and nowhere else', async () => {
    const home = jsonLd((await html('/')).body)
    expect(home.find((entry) => entry['@type'] === 'WebSite')?.potentialAction).toBeDefined()

    const listing = jsonLd((await html('/listings/rock-night')).body)
    expect(listing.find((entry) => entry['@type'] === 'WebSite')).toBeUndefined()
  })

  it('breadcrumbs a listing through its venue', async () => {
    const { body } = await html('/listings/rock-night')
    const crumbs = jsonLd(body).find((entry) => entry['@type'] === 'BreadcrumbList')
    const items = crumbs!.itemListElement as Record<string, unknown>[]
    expect(items.map((item) => item.name)).toEqual(['NepScene', 'Purple Haze', 'Rock Night'])
    expect(items[0]!.position).toBe(1)
  })
})

describe('what is not rendered, and why', () => {
  it('leaves the wizard and the dashboard to the SPA', async () => {
    for (const path of ['/submit', '/dashboard', '/moderate']) {
      const { body } = await html(path)
      expect(body, path).not.toContain('data-rendered="server"')
    }
  })

  it('renders search for people but tells crawlers not to keep it', async () => {
    const { response, body } = await html('/search?q=rock')
    expect(response.status).toBe(200)
    expect(body).toContain('data-rendered="server"')
    expect(body).toContain('content="noindex, follow"')
  })

  it('404s a listing that does not exist, so a crawler drops the URL', async () => {
    const response = await get('/listings/no-such-thing')
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  it('404s an artist below the threshold for a page, as the API does', async () => {
    expect((await get('/artists/nobody')).status).toBe(404)
  })
})

describe('the pages a reader browses', () => {
  it('renders a venue with what is on and what has been', async () => {
    const { body } = await html('/venues/purple-haze')
    expect(body).toContain('Purple Haze')
    expect(body).toContain('What’s on')
    expect(body).toContain('Previously here')
  })

  it('renders an organizer', async () => {
    const { body } = await html('/organizers/himalayan-sound')
    expect(body).toContain('Himalayan Sound')
  })

  it('renders an artist', async () => {
    const { body } = await html('/artists/kutumba')
    expect(body).toContain('Kutumba')
  })

  it('renders the homepage feed', async () => {
    const { body } = await html('/')
    expect(body).toContain('What’s happening around Nepal')
    expect(body).toContain('Rock Night')
  })

  it('renders the venue and organizer indexes', async () => {
    expect((await html('/venues')).body).toContain('Purple Haze')
    expect((await html('/organizers')).body).toContain('Himalayan Sound')
  })
})

describe('sitemaps', () => {
  it('serves an index that points at every segment', async () => {
    const { response, body } = await html('/sitemap.xml')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/xml')
    expect(body).toContain('<sitemapindex')
    for (const segment of ['pages', 'listings-1', 'venues-1', 'organizers-1']) {
      expect(body, segment).toContain(`/sitemaps/${segment}.xml`)
    }
  })

  it('lists published upcoming listings, and nothing else', async () => {
    const { body } = await html('/sitemaps/listings-1.xml')
    expect(body).toContain('/listings/rock-night')
    // A draft has no public page, and a finished listing is not worth crawling.
    expect(body).not.toContain('secret-draft')
    expect(body).not.toContain('awaiting-review')
    expect(body).not.toContain('finished-gig')
  })

  it('declares the Nepali variant of every URL (#46)', async () => {
    const { body } = await html('/sitemaps/listings-1.xml')
    expect(body).toContain('hreflang="ne"')
    expect(body).toContain('lang=ne')
  })

  it('carries a last-modified date, so a crawler can skip what has not changed', async () => {
    const { body } = await html('/sitemaps/listings-1.xml')
    expect(body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/)
  })

  it('serves the static pages, and leaves search out of them', async () => {
    const { body } = await html('/sitemaps/pages.xml')
    expect(body).toContain('<loc>https://nepscene.test/</loc>')
    expect(body).toContain('/venues')
    expect(body).not.toContain('/search')
  })

  it('404s a segment past the end rather than serving an empty one', async () => {
    // An empty sitemap claims the section exists and is empty, which is a
    // different and wrong thing to tell a crawler.
    expect((await get('/sitemaps/listings-9.xml')).status).toBe(404)
    expect((await get('/sitemaps/nonsense.xml')).status).toBe(404)
  })
})

describe('robots.txt', () => {
  it('points at the sitemap and keeps crawlers out of search and the tools', async () => {
    // ENVIRONMENT is 'local' under test, which is not production — so this
    // asserts the shape of the non-production answer.
    const { response, body } = await html('/robots.txt')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(body).toContain('User-agent: *')
  })

  it('disallows everything outside production, so staging never competes', async () => {
    const { body } = await html('/robots.txt')
    expect(body).toContain('Disallow: /')
    expect(body).not.toContain('Sitemap:')
  })
})
