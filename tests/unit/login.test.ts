import { describe, expect, it } from 'vitest'
import { safeNext } from '../../app/lib/safeNext'

// `?next=` is attacker-writable: it arrives in a link. Only a path on this
// site may be followed after sign-in.
describe('safeNext', () => {
  it('follows a path on this site', () => {
    expect(safeNext('/dashboard')).toBe('/dashboard')
    expect(safeNext('/venues/purple-haze?tab=upcoming')).toBe('/venues/purple-haze?tab=upcoming')
  })

  it('falls back to the dashboard when there is nowhere sensible to go', () => {
    expect(safeNext(null)).toBe('/dashboard')
    expect(safeNext('')).toBe('/dashboard')
    expect(safeNext('/login')).toBe('/dashboard')          // would loop
    expect(safeNext('/login?next=/x')).toBe('/dashboard')
  })

  it('refuses anything that leaves the site', () => {
    expect(safeNext('https://evil.example/')).toBe('/dashboard')
    expect(safeNext('//evil.example/')).toBe('/dashboard')
    expect(safeNext('javascript:alert(1)')).toBe('/dashboard')
  })
})
