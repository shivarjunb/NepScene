/**
 * The NepScene mark (#19).
 *
 * A Himalayan skyline under a sun, in an accent badge — the product in one
 * glyph. Three straight peaks and one disc, because at 16px the silhouette is
 * all that survives and anything finer turns to mud. The same glyph is the
 * favicon, the app icon and the wordmark's lockup, so there is one mark rather
 * than a family of near-misses.
 *
 * The badge takes --accent, which #77 set to WaahTickets' violet. The mark was
 * drawn for Nepal's flag crimson and #19 argued for keeping the two products
 * visually distinct; that argument lost to an explicit call for an exact
 * match. Reversing it is one token, not a redraw.
 */
export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32"
         role={title ? 'img' : 'presentation'} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M6.4 22.6 12.4 12l3.9 6 3-4.2 6.3 8.8H6.4Z" fill="var(--text-on-accent)" />
      <circle cx="10.6" cy="8.9" r="2.1" fill="var(--text-on-accent)" />
    </svg>
  )
}

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo__word">
        Nep<span className="logo__word-accent">Scene</span>
      </span>
    </span>
  )
}
