import type { ComponentProps } from 'react'
import { Spinner } from '../components/primitives'
import { deferred } from '../lib/deferred'
import type { NepalMap } from './NepalMap'

/**
 * The map, fetched when a page first shows one (#39).
 *
 * `NepalMap` and what it pulls in — grouping, clustering, the viewport
 * arithmetic, the popup and the stack, the Maps SDK loader — were a third of
 * the first paint on every page, and only two pages have a map on them. On
 * those two the chunk arrives alongside the Maps SDK, which the map was
 * already waiting on: the frame below is what a viewer would have seen at
 * that moment anyway.
 *
 * The frame is the map's own shell — same class, same height, same veil — so
 * nothing moves when the real thing takes its place.
 */
export const DeferredNepalMap = deferred<ComponentProps<typeof NepalMap>>(
  () => import('./NepalMap').then((module) => module.NepalMap),
  <div className="nepal-map">
    <div className="nepal-map__veil"><Spinner /> <span>Loading the map…</span></div>
  </div>,
)
