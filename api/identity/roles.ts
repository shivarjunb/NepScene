/**
 * Roles and permissions (#28). Four roles, one per user, and a permission
 * matrix rather than role checks scattered through handlers — a handler asks
 * "may this user publish?", never "is this user an editor?", so widening a
 * role later is one line here instead of a grep.
 */
export const ROLES = ['visitor', 'organizer', 'editor', 'admin'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'listing:create',
  'listing:edit_own',
  'listing:edit_any',
  'listing:publish',
  'listing:moderate',
  'venue:create',
  'venue:edit_any',
  'media:upload',
  'organization:manage',
  'user:manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const MATRIX: Record<Role, readonly Permission[]> = {
  // A visitor can read the catalogue, which needs no account at all.
  visitor: [],
  organizer: ['listing:create', 'listing:edit_own', 'venue:create', 'media:upload'],
  editor: [
    'listing:create', 'listing:edit_own', 'listing:edit_any', 'listing:publish',
    'listing:moderate', 'venue:create', 'venue:edit_any', 'media:upload',
  ],
  admin: [...PERMISSIONS],
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission)
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]]
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}
