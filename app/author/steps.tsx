import { useState } from 'react'
import type { ListingInput, FieldError } from '../../api/author/validate'
import { LISTING_TYPES, needsTicketUrl } from '../../api/author/validate'
import { Alert, Badge, Button, Checkbox, Chip, Field, Input, Select, Textarea } from '../components/primitives'
import type { Lookups, SavedListing } from '../lib/author'
import { uploadMedia } from '../lib/author'
import { MapLocationPicker } from './MapLocationPicker'
import { VenuePicker } from './VenuePicker'
import { formatCoordinates } from './geocode'

/**
 * The wizard's step bodies (#30). Each is a plain function of the listing and a
 * setter, so a step can be rendered and tested without the wizard around it.
 *
 * The commerce steps are gone rather than hidden — WaahTickets' step 3 was
 * ticket types and step 4 was coupons, which is most of the 1,207 lines this
 * came from and none of what NepScene does (docs/SCOPE.md).
 */

export type StepProps = {
  listing: ListingInput
  set: (patch: Partial<ListingInput>) => void
  lookups: Lookups
  errors: FieldError[]
}

/** The message for one field, or undefined — the shape `Field` wants. */
const errorFor = (errors: FieldError[], field: keyof ListingInput) =>
  errors.find((error) => error.field === field)?.message

const TYPE_LABELS: Record<(typeof LISTING_TYPES)[number], { label: string; hint: string }> = {
  free: { label: 'Free to attend', hint: 'No ticket needed' },
  ticketed_external: { label: 'Ticketed elsewhere', hint: 'You sell tickets on another site' },
  ticketed_internal: { label: 'Ticketed on WaahTickets', hint: 'Entry is sold through WaahTickets' },
  announcement: { label: 'Announcement', hint: 'News with no place or door time' },
}

// ── Details ─────────────────────────────────────────────────────────────────

export function DetailsStep({ listing, set, lookups, errors }: StepProps) {
  return (
    <div className="wizard__fields">
      <Field label="Title" hint="What people will see first"
             error={errorFor(errors, 'title')}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}
                 value={listing.title} autoComplete="off"
                 onChange={(e) => set({ title: e.target.value })} />
        )}
      </Field>

      <fieldset className="wizard__fieldset">
        <legend className="field__label">What kind of listing is this?</legend>
        <div className="wizard__types" role="radiogroup" aria-label="Listing type">
          {LISTING_TYPES.map((type) => (
            <label key={type} className="wizard__type">
              <input type="radio" name="listing_type" value={type}
                     checked={listing.listing_type === type}
                     onChange={() => set({ listing_type: type })} />
              <span>
                <strong>{TYPE_LABELS[type].label}</strong>
                <small>{TYPE_LABELS[type].hint}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/*
        The conditional field. Only an external listing carries a ticket link,
        and for it the link is the whole point — a listing nobody can act on.
        Nothing here asks for a price: NepScene renders offers and never
        computes them (docs/SCOPE.md).
      */}
      {needsTicketUrl(listing.listing_type) && (
        <Field label="Where people get tickets"
               hint="The page on your ticketing site"
               error={errorFor(errors, 'offer_url')}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="url" inputMode="url" placeholder="https://"
                   aria-describedby={describedBy} aria-invalid={invalid || undefined}
                   value={listing.offer_url ?? ''}
                   onChange={(e) => set({ offer_url: e.target.value || null })} />
          )}
        </Field>
      )}

      <Field label="One-line summary" hint="Shown on cards and map pins"
             error={errorFor(errors, 'summary')}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}
                 value={listing.summary ?? ''} maxLength={300}
                 onChange={(e) => set({ summary: e.target.value || null })} />
        )}
      </Field>

      <Field label="Description" hint="The full story. Optional, but it is what sells a night out."
             error={errorFor(errors, 'description')}>
        {({ id, describedBy, invalid }) => (
          <Textarea id={id} rows={6} aria-describedby={describedBy}
                    aria-invalid={invalid || undefined} value={listing.description ?? ''}
                    onChange={(e) => set({ description: e.target.value || null })} />
        )}
      </Field>

      <CategoryPicker listing={listing} set={set} lookups={lookups} errors={errors} />
      <TagPicker listing={listing} set={set} lookups={lookups} errors={errors} />

      <Field label="Event website" hint="The event's own home on the web, if it has one"
             error={errorFor(errors, 'external_url')}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="url" inputMode="url" placeholder="https://"
                 aria-describedby={describedBy} aria-invalid={invalid || undefined}
                 value={listing.external_url ?? ''}
                 onChange={(e) => set({ external_url: e.target.value || null })} />
        )}
      </Field>

      {lookups.organizations.length > 0 && (
        <Field label="Listing on behalf of"
               hint="Leave as yourself for a community event">
          {({ id }) => (
            <Select id={id} value={listing.organization_id ?? ''}
                    onChange={(e) => set({ organization_id: e.target.value || null })}>
              <option value="">Myself</option>
              {lookups.organizations.map((org) => (
                <option key={org.id} value={org.id}>{org.name}</option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </div>
  )
}

/**
 * Categories are the closed half of the taxonomy, so this is a fixed list of
 * toggles rather than a text field. The primary one decides the map pin, which
 * is why it is chosen here and not left to whichever row the database returns
 * first (migration 0005).
 */
function CategoryPicker({ listing, set, lookups, errors }: StepProps) {
  const toggle = (slug: string) => {
    const chosen = listing.category_slugs.includes(slug)
      ? listing.category_slugs.filter((s) => s !== slug)
      : [...listing.category_slugs, slug]
    set({
      category_slugs: chosen,
      // Dropping the primary category has to move it, not leave it dangling.
      primary_category_slug: chosen.includes(listing.primary_category_slug ?? '')
        ? listing.primary_category_slug
        : chosen[0] ?? null,
    })
  }

  return (
    <fieldset className="wizard__fieldset">
      <legend className="field__label">Categories</legend>
      <p className="field__hint" id="category-hint">
        Pick every one that fits. The first decides the colour of your map pin.
      </p>
      <div className="wizard__chips" aria-describedby="category-hint">
        {lookups.categories.map((category) => (
          <Chip key={category.slug}
                pressed={listing.category_slugs.includes(category.slug)}
                onToggle={() => toggle(category.slug)}>
            {category.name}
          </Chip>
        ))}
      </div>
      {errorFor(errors, 'category_slugs') && (
        <span className="field__error" role="alert">{errorFor(errors, 'category_slugs')}</span>
      )}

      {listing.category_slugs.length > 1 && (
        <Field label="Main category" hint="The one your pin takes its look from">
          {({ id }) => (
            <Select id={id} value={listing.primary_category_slug ?? ''}
                    onChange={(e) => set({ primary_category_slug: e.target.value || null })}>
              {listing.category_slugs.map((slug) => (
                <option key={slug} value={slug}>
                  {lookups.categories.find((c) => c.slug === slug)?.name ?? slug}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </fieldset>
  )
}

/** Tags are the open half: anything anyone types, normalised on the way in. */
function TagPicker({ listing, set, lookups }: StepProps) {
  const [entry, setEntry] = useState('')

  const add = (value: string) => {
    const tag = value.trim()
    if (!tag || listing.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return
    set({ tags: [...listing.tags, tag] })
    setEntry('')
  }

  return (
    <fieldset className="wizard__fieldset">
      <legend className="field__label">Tags</legend>
      <p className="field__hint" id="tag-hint">
        Anything a category cannot say — holi, open mic, kids welcome.
      </p>

      {listing.tags.length > 0 && (
        <ul className="wizard__tags">
          {listing.tags.map((tag) => (
            <li key={tag}>
              <Badge>{tag}</Badge>
              <Button variant="ghost" size="sm" aria-label={`Remove tag ${tag}`}
                      onClick={() => set({ tags: listing.tags.filter((t) => t !== tag) })}>
                ✕
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="wizard__tag-entry">
        <Input aria-label="Add a tag" aria-describedby="tag-hint" value={entry}
               onChange={(e) => setEntry(e.target.value)}
               onKeyDown={(e) => {
                 // Enter adds the tag rather than submitting the step — the
                 // browser's default here would skip the author to the next
                 // page mid-thought.
                 if (e.key === 'Enter') { e.preventDefault(); add(entry) }
               }} />
        <Button variant="secondary" onClick={() => add(entry)} disabled={!entry.trim()}>
          Add
        </Button>
      </div>

      {lookups.tags.length > 0 && (
        <div className="wizard__chips">
          {lookups.tags.slice(0, 12)
            .filter((tag) => !listing.tags.some((t) => t.toLowerCase() === tag.label.toLowerCase()))
            .map((tag) => (
              <Chip key={tag.slug} onToggle={() => add(tag.label)}>+ {tag.label}</Chip>
            ))}
        </div>
      )}
    </fieldset>
  )
}

// ── When ────────────────────────────────────────────────────────────────────

/**
 * The form works in `datetime-local`, which has no zone, and the API stores
 * ISO-8601 UTC. These two convert at the edge so the rest of the wizard only
 * ever handles one format.
 */
const toLocalInput = (iso: string | null): string => {
  if (!iso) return ''
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return ''
  const date = new Date(parsed)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const fromLocalInput = (value: string): string | null => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

export function WhenStep({ listing, set, lookups, errors }: StepProps) {
  return (
    <div className="wizard__fields">
      <Field label="Starts" error={errorFor(errors, 'starts_at')}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="datetime-local" aria-describedby={describedBy}
                 aria-invalid={invalid || undefined} value={toLocalInput(listing.starts_at)}
                 onChange={(e) => set({ starts_at: fromLocalInput(e.target.value) ?? '' })} />
        )}
      </Field>

      <Field label="Ends" hint="Leave empty if it runs until it is over"
             error={errorFor(errors, 'ends_at')}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="datetime-local" aria-describedby={describedBy}
                 aria-invalid={invalid || undefined} value={toLocalInput(listing.ends_at)}
                 onChange={(e) => set({ ends_at: fromLocalInput(e.target.value) })} />
        )}
      </Field>

      <Checkbox label="Runs all day" checked={listing.is_all_day}
                onChange={(e) => set({ is_all_day: e.target.checked })} />

      <Field label="Timezone"
             hint="Times show in the listing's own zone, so an event in Pokhara starts when it starts there"
             error={errorFor(errors, 'timezone')}>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} value={listing.timezone}
                  onChange={(e) => set({ timezone: e.target.value })}>
            {lookups.timezones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </Select>
        )}
      </Field>
    </div>
  )
}

// ── Where ───────────────────────────────────────────────────────────────────

/**
 * Where it happens: which venue, which room inside it, and — when the thing is
 * not at the venue's own address — a pin of the listing's own (#31).
 *
 * The venue search and the map live in their own components; what is decided
 * here is the *order*. Venue first, because a venue carries a pin already and
 * most listings need no further placing. The override below it is for the
 * cases a venue cannot express: a street festival, a stage in a field, a car
 * park round the back of the building the venue row names.
 */
export function WhereStep({ listing, set, lookups, errors, onVenueCreated }: StepProps & {
  /**
   * A venue created inside the picker is not in the lookups the wizard loaded,
   * so it is handed back up. Without this the Review step and the summary above
   * would show "Not set" for a venue that was just made — the id is on the
   * listing, but nothing knows its name.
   */
  onVenueCreated: (venue: Lookups['venues'][number]) => void
}) {
  const venue = lookups.venues.find((v) => v.id === listing.venue_id) ?? null
  const override = listing.location_lat !== null || listing.location_lng !== null

  return (
    <div className="wizard__fields">
      <VenuePicker
        selected={venue ? { id: venue.id, name: venue.name, latitude: venue.latitude, longitude: venue.longitude } : null}
        error={errorFor(errors, 'venue_id')}
        onSelect={(picked) => {
          if (picked && !lookups.venues.some((v) => v.id === picked.id)) {
            onVenueCreated({
              id: picked.id, name: picked.name, area: null, city: null,
              latitude: picked.latitude, longitude: picked.longitude,
            })
          }
          set({ venue_id: picked?.id ?? null })
        }}
      />

      {venue && (
        <Field label="Room, hall or stage"
               hint="Optional — “Hall B”, “Main stage”. Leave blank if the whole venue is the venue."
               error={errorFor(errors, 'venue_room')}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}
                   value={listing.venue_room ?? ''}
                   placeholder="Hall B"
                   onChange={(e) => set({ venue_room: e.target.value || null })} />
          )}
        </Field>
      )}

      {venue && venue.latitude !== null && venue.longitude !== null && !override && (
        <p className="wizard__note">
          Pinned at {formatCoordinates(venue.latitude, venue.longitude)} from the venue record.
        </p>
      )}

      <Checkbox
        label="This happens somewhere other than the venue's registered address"
        checked={override}
        onChange={(e) => set(e.target.checked
          ? {
              location_lat: venue?.latitude ?? DEFAULT_PIN.lat,
              location_lng: venue?.longitude ?? DEFAULT_PIN.lng,
            }
          : { location_lat: null, location_lng: null })}
      />

      {override && (
        <MapLocationPicker
          label="Where this listing actually happens"
          lat={listing.location_lat} lng={listing.location_lng}
          onMove={(lat, lng) => set({ location_lat: lat, location_lng: lng })}
        />
      )}
    </div>
  )
}

/** The centre of Kathmandu — a pin the author will move, not one they will keep. */
const DEFAULT_PIN = { lat: 27.7172, lng: 85.324 }

// ── Media ───────────────────────────────────────────────────────────────────

export function MediaStep({ listingId, media, onUploaded }: {
  listingId: string | null
  media: SavedListing['media']
  onUploaded: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [altText, setAltText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload() {
    if (!file || !listingId) return
    setBusy(true)
    setError(null)
    try {
      await uploadMedia(listingId, file, altText)
      setFile(null)
      setAltText('')
      onUploaded()
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'That upload did not work')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wizard__fields">
      {media.length > 0 && (
        <ul className="wizard__media">
          {media.map((item) => (
            <li key={item.id}>
              <img src={item.url} alt={item.alt_text ?? ''} width={item.width ?? undefined}
                   height={item.height ?? undefined} loading="lazy" />
            </li>
          ))}
        </ul>
      )}

      {!listingId && (
        <Alert tone="info">Your listing saves itself as you type. Add a title first, then come back for pictures.</Alert>
      )}

      {error && <Alert tone="danger" title="Upload failed">{error}</Alert>}

      <Field label="Add a picture" hint="JPEG, PNG, WebP or AVIF, up to 10MB">
        {({ id }) => (
          <Input id={id} type="file" accept="image/jpeg,image/png,image/webp,image/avif"
                 disabled={!listingId}
                 onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        )}
      </Field>

      {/*
        Not optional, and not phrased as though it were. An image with no alt
        text is a WCAG 2.1 AA failure the moment it renders (#49), so the API
        rejects one and the form says why before it is sent.
      */}
      <Field label="Describe the picture"
             hint="For people using a screen reader. Say what is in it, not that it is a photo.">
        {({ id }) => (
          <Input id={id} value={altText} disabled={!listingId}
                 onChange={(e) => setAltText(e.target.value)} />
        )}
      </Field>

      <Button onClick={upload} loading={busy}
              disabled={!file || !altText.trim() || !listingId}>
        Upload
      </Button>
    </div>
  )
}

// ── Appearance ──────────────────────────────────────────────────────────────

/**
 * A preview rather than a picker. Pin appearance is *derived* from the primary
 * category and has no column of its own — that duplicate field is precisely
 * what made WaahTickets' pins and filter chips disagree (migration 0005). The
 * popup customiser on top of this derivation is #32.
 */
export function AppearanceStep({ listing, lookups }: Pick<StepProps, 'listing' | 'lookups'>) {
  const primary = lookups.categories.find((c) => c.slug === listing.primary_category_slug)

  return (
    <div className="wizard__fields">
      <p className="wizard__note">
        Your pin takes its colour and icon from the main category, so the map and
        the filter chips always agree.
      </p>

      <div className="wizard__pin-preview">
        <span className="wizard__pin" style={{ background: primary?.color ?? 'var(--accent)' }}
              aria-hidden="true" />
        <div>
          <strong>{listing.title || 'Your listing'}</strong>
          <p>{listing.summary ?? 'Your one-line summary appears here.'}</p>
          <Badge tone="accent">{primary?.name ?? 'No category yet'}</Badge>
        </div>
      </div>

      {!primary && (
        <Alert tone="warning" title="No main category">
          Go back to the first step and pick one — without it your listing has no
          pin colour and sits under no filter.
        </Alert>
      )}

      <Alert tone="info" title="More control coming">
        Choosing what the popup shows, and overriding the icon, arrive with the
        pin appearance work (#32).
      </Alert>
    </div>
  )
}

// ── Review ──────────────────────────────────────────────────────────────────

export function ReviewStep({ listing, lookups, errors, onJump }: StepProps & {
  onJump: (field: string) => void
}) {
  const venue = lookups.venues.find((v) => v.id === listing.venue_id)
  const when = listing.starts_at
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'full', timeStyle: listing.is_all_day ? undefined : 'short',
        timeZone: listing.timezone,
      }).format(new Date(listing.starts_at))
    : 'Not set'

  return (
    <div className="wizard__fields">
      {errors.length > 0 && (
        <Alert tone="danger" title="Not ready to send yet">
          <ul className="wizard__error-list">
            {errors.map((error) => (
              <li key={`${error.field}-${error.message}`}>
                <button type="button" className="wizard__error-link"
                        onClick={() => onJump(error.field)}>
                  {error.message}
                </button>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <dl className="wizard__summary">
        <dt>Title</dt><dd>{listing.title || <em>Not set</em>}</dd>
        <dt>Kind</dt><dd>{TYPE_LABELS[listing.listing_type].label}</dd>
        <dt>When</dt><dd>{when}</dd>
        <dt>Where</dt>
        <dd>
          {venue
            ? [venue.name, listing.venue_room].filter(Boolean).join(' — ')
            : <em>Not set</em>}
          {listing.location_lat !== null && listing.location_lng !== null && (
            <span className="wizard__note">
              Own pin at {formatCoordinates(listing.location_lat, listing.location_lng)}
            </span>
          )}
        </dd>
        <dt>Categories</dt>
        <dd>
          {listing.category_slugs.length > 0
            ? listing.category_slugs
                .map((slug) => lookups.categories.find((c) => c.slug === slug)?.name ?? slug)
                .join(', ')
            : <em>None</em>}
        </dd>
        {listing.tags.length > 0 && <><dt>Tags</dt><dd>{listing.tags.join(', ')}</dd></>}
        {listing.offer_url && (
          <><dt>Tickets</dt><dd><a href={listing.offer_url}>{listing.offer_url}</a></dd></>
        )}
      </dl>

      <Alert tone="info" title="What happens next">
        Sending this for review puts it in the editors' queue. Nothing is public
        until one of them publishes it.
      </Alert>
    </div>
  )
}
