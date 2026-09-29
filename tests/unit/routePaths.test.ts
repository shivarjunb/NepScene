import { describe, expect, it } from 'vitest'
import { DYNAMIC_PREFIXES, STATIC_PATHS, isAppPath } from '../../app/lib/routePaths'

/**
 * The Worker's answer to "does the app have a page here" (api/index.ts). The
 * router is typed against the same lists, so the only thing left to pin is
 * the matching itself: exact for the static paths, prefix-with-a-slug for
 * the dynamic ones.
 */
describe('isAppPath', () => {
  it('knows every static path, exactly', () => {
    for (const path of STATIC_PATHS) expect(isAppPath(path), path).toBe(true)
    expect(isAppPath('/venues/')).toBe(false)
    expect(isAppPath('/Venues')).toBe(false)
    expect(isAppPath('/login/')).toBe(false)
  })

  it('takes a dynamic prefix only with something after it', () => {
    for (const prefix of DYNAMIC_PREFIXES) {
      expect(isAppPath(`${prefix}x`), prefix).toBe(true)
      expect(isAppPath(prefix), prefix).toBe(false)
      // One segment, as the renderer reads it (api/render/routes.ts): a
      // deeper path is not a slug the app could ever resolve.
      expect(isAppPath(`${prefix}x/y`), prefix).toBe(false)
    }
  })

  it('has nothing for the paths that used to be soft 404s', () => {
    for (const path of ['/nope', '/wp-admin', '/index.php', '/favicon.ico', '/api', '/listings']) {
      expect(isAppPath(path), path).toBe(false)
    }
  })
})
