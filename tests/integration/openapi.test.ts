import { SELF } from 'cloudflare:test'
import Ajv from 'ajv'
import { beforeAll, describe, expect, it } from 'vitest'
import { SCHEMAS } from '../../api/openapi'
import { seedCatalogue } from '../helpers/seed'

/**
 * The contract is only worth having if it is checked. These validate real
 * responses against the schemas the API publishes, so a handler that changes
 * shape without the document changing with it fails here.
 */
const ajv = new Ajv({ strict: false, allErrors: true })
const validators = {
  ListingPage: ajv.compile(SCHEMAS.ListingPage),
  ListingDetail: ajv.compile(SCHEMAS.ListingDetail),
  SearchResult: ajv.compile(SCHEMAS.SearchResult),
  Suggestion: ajv.compile(SCHEMAS.Suggestion),
  Error: ajv.compile(SCHEMAS.Error),
}

const get = async (path: string) => {
  const response = await SELF.fetch(`https://nepscene.test${path}`)
  return { response, body: await response.json() }
}

function check(name: keyof typeof validators, body: unknown) {
  const validate = validators[name]
  if (!validate(body)) {
    throw new Error(`${name} mismatch: ${ajv.errorsText(validate.errors, { separator: '\n  ' })}`)
  }
}

beforeAll(seedCatalogue)

describe('GET /api/openapi.json', () => {
  it('is served and describes every catalog endpoint', async () => {
    const { response, body } = await get('/api/openapi.json')
    expect(response.status).toBe(200)
    const document = body as any
    expect(document.openapi).toBe('3.1.0')
    for (const path of [
      '/api/catalog/listings', '/api/catalog/listings/{slug}', '/api/catalog/search',
      '/api/catalog/suggest', '/api/catalog/venues', '/api/catalog/venues/{slug}',
      '/api/catalog/organizers', '/api/catalog/organizers/{slug}',
      '/api/catalog/artists/{slug}', '/api/catalog/categories', '/api/catalog/bootstrap',
    ]) {
      expect(document.paths[path], path).toBeDefined()
    }
  })
})

describe('responses match the documented schema', () => {
  it('the listings feed', async () => {
    check('ListingPage', (await get('/api/catalog/listings')).body)
  })

  it('a feed with every filter applied', async () => {
    check('ListingPage', (await get(
      '/api/catalog/listings?category=concerts&city=Kathmandu&type=ticketed_internal&limit=5')).body)
  })

  it('search, including the distance field it adds', async () => {
    const { body } = await get('/api/catalog/search?q=rock&lat=27.7154&lng=85.3105&radius_km=20')
    // A search is a superset of a page: the rows are the same shape, and the
    // facets, correction and alternatives ride on top (#42).
    check('ListingPage', body)
    check('SearchResult', body)
    expect((body as any).data.every((l: any) => typeof l.distance_km === 'number')).toBe(true)
  })

  it('a search with facets, a correction and alternatives', async () => {
    check('SearchResult', (await get('/api/catalog/search')).body)
    check('SearchResult', (await get('/api/catalog/search?q=zzzqqq')).body)
  })

  it('suggestions', async () => {
    const { body } = await get('/api/catalog/suggest?q=roc')
    for (const suggestion of (body as any).data) check('Suggestion', suggestion)
  })

  it('a listing detail, with media and artists', async () => {
    check('ListingDetail', (await get('/api/catalog/listings/rock-night')).body)
  })

  it('a free listing, whose offer is null rather than zero', async () => {
    const { body } = await get('/api/catalog/listings/lake-cleanup')
    check('ListingDetail', body)
    expect((body as any).offer).toBeNull()
  })

  it('errors', async () => {
    check('Error', (await get('/api/catalog/listings?limit=999')).body)
    check('Error', (await get('/api/catalog/listings/nothing-here')).body)
  })
})
