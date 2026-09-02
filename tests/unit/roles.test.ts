import { describe, expect, it } from 'vitest'
import { can, permissionsFor, PERMISSIONS } from '../../api/identity/roles'

describe('permissions', () => {
  it('gives a visitor nothing — reading needs no account at all', () => {
    expect(permissionsFor('visitor')).toEqual([])
  })

  it('lets an organizer author but not publish or moderate', () => {
    expect(can('organizer', 'listing:create')).toBe(true)
    expect(can('organizer', 'media:upload')).toBe(true)
    expect(can('organizer', 'listing:publish')).toBe(false)
    expect(can('organizer', 'listing:moderate')).toBe(false)
    expect(can('organizer', 'listing:edit_any')).toBe(false)
  })

  it('lets an editor publish and moderate but not manage users', () => {
    expect(can('editor', 'listing:publish')).toBe(true)
    expect(can('editor', 'listing:moderate')).toBe(true)
    expect(can('editor', 'user:manage')).toBe(false)
  })

  it('gives an admin everything, so a new permission is never quietly ungranted', () => {
    for (const permission of PERMISSIONS) expect(can('admin', permission)).toBe(true)
  })
})
