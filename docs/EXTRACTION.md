# Extraction from WaahTickets

What comes across, what gets rewritten, and what stays behind.

Source: `shivarjunb/WaahTickets` @ `f54719a`.

## Port largely intact

These are good and should be moved with minimal change.

| Source | Destination | Notes |
|---|---|---|
| `apps/web/src/features/public/NepalMap.tsx` | `app/public/map/NepaMap.tsx` | Already on Google Maps |
| `apps/web/src/features/public/venueGrouping.ts` | `app/public/map/venueGrouping.ts` | Plus its 15 passing tests |
| `apps/web/src/features/public/EventMapPopup.tsx` | `app/public/map/ListingMapPopup.tsx` | Strip price/offer coupling |
| `apps/web/src/features/public/HeroLiveMap.tsx` | `app/public/map/HeroMap.tsx` | Keep IP city detection, distance chips |
| `apps/web/src/features/public/heroMapStyles.css` | `app/styles/map.css` | Remove dead Leaflet class names |
| `apps/web/src/features/admin/MapLocationPicker.tsx` | `app/author/MapLocationPicker.tsx` | Already on Google Maps |
| `apps/web/src/features/admin/MapPinAppearance.tsx` | `app/author/MapPinAppearance.tsx` | Leaflet residue to clean |
| `apps/web/src/features/admin/MapPopupCustomizer.tsx` | `app/author/MapPopupCustomizer.tsx` | |
| `apps/web/src/shared/utils.tsx` | `app/shared/utils.ts` | Drop money helpers |
| `src/utils/errors.ts` | `api/utils/errors.ts` | |

## Port with significant surgery

| Source | Why it changes |
|---|---|
| `apps/web/src/features/admin/CreateEventWizard.tsx` (1,207 lines) | Remove the ticket-type and coupon steps entirely — roughly half the wizard. What remains is: details, location, media, map appearance, publish. |
| `apps/web/src/features/public/PublicApp.tsx` (4,545 lines) | Do **not** port as a unit. Harvest the discovery pieces — category filtering, event grid, rails — into separate components. The monolith is the thing we are escaping. |
| `apps/web/src/styles.css` (13,569 lines) | Extract a token layer first, then port only the selectors discovery actually uses. Carrying this file across intact would import the problem. |
| `src/api/crud.ts` (7,011 lines) | Take the public event query and the generic CRUD engine. Leave everything commerce. Rebuild as catalog + author modules. |
| `src/db/schema.ts` | Reshape around listings and venues rather than events and event_locations. |

## Do not port

Everything commerce, and the reasons are in the audit:

- `checkout`, `payments`, `orders`, `order_items`, `tickets`, `cart_holds`
- `coupons`, `coupon_redemptions`, `commission_*`, `referral_*`, `payout_*`, `refunds`
- `apps/web/src/features/validator/`, `apps/mobile/src/screens/ValidatorScreen/`
- `src/api/reports.ts` — financial reporting is a WaahTickets concern
- `src/notifications/service.ts` (2,321 lines) — it conflates email with ticket
  issuance. NepScene needs notifications, but built fresh and not coupled to
  anything transactional.
- `src/cache/upstash.ts` — measured in production on 2026-09-02: the Upstash
  database had been deleted and the wrapper added ~1.7s of slow-failing calls to
  every request while never hitting. The design flaw is architectural, not
  operational — an external cache is a full internet round trip from the serving
  colo even when healthy. NepScene uses the Cache API and KV instead
  (see ARCHITECTURE.md, "The read path").

## Known issues to fix during extraction, not carry over

Findings from the 2026-08-20 audit that touch code we are porting:

| Finding | Fix on the way in |
|---|---|
| **F4** — public events endpoint unbounded and serving finished events | Catalog API is paginated and upcoming-by-default from day one (`CORE-009` equivalent, folded into the Catalog API feature) |
| **F7** — `tests/ads.test.ts` ad rotation returns `undefined` | Fix before porting the ad platform, or leave ads out of MVP |
| Upstash cache wrapper (dead backend added ~1.7s/request in prod) | Not ported — replaced by Cache API + KV, see ARCHITECTURE.md |
| Partial Google Maps migration | Finish it — remove Leaflet class names and dead CSS during the port |
| `date-utils.ts` is an empty file | Delete rather than port |

## Sequencing note

Port the map **after** the design tokens and the catalog API exist. The map is the
most valuable single asset here, and porting it into an app with no token layer and
no bounded data source means porting it twice.
