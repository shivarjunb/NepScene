/**
 * Where to go after signing in (#27).
 *
 * `?next=` is attacker-writable: it arrives in a link. Only a path on this
 * site is honoured — an absolute URL or a protocol-relative `//host` would
 * make /login an open redirect — and never /login itself, which would loop.
 *
 * Its own module, with no React in it, so the unit test can reach it without
 * dragging the page and the router into the Worker's DOM-less typecheck.
 */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/login')) return '/dashboard'
  return raw
}
