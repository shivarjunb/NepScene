import { useEffect, useRef, useState } from 'react'
import { Alert, Badge, Button, Field, Input, Spinner, Textarea } from '../components/primitives'
import {
  AuthorError, DuplicateVenueError, createVenue, searchVenues,
  type VenueMatch,
} from '../lib/author'
import type { DuplicateWarning } from '../../api/author/venueMatch'
import { emptyVenue, validateVenue, type VenueInput } from '../../api/author/validate'
import { MapLocationPicker } from './MapLocationPicker'

/**
 * The venue half of the Where step (#31): find the one that exists before
 * offering to make another.
 *
 * The whole component is arranged around that sentence. Creating a venue is
 * not a button next to the search box; it is something that appears
 * *underneath the results*, once there are results to look past, and only when
 * the server says nothing already matches exactly. If adding one were the
 * easier path, everyone would take it, and the catalogue would re-accumulate
 * the duplicates canonical venues were built to remove (#21).
 *
 * The duplicate check is the server's — `POST /api/author/venues` answers 409
 * naming what the new venue resembles, and refuses rather than creating it and
 * warning afterwards. This component's job is to make that 409 look like a
 * question with two real answers instead of like a failure.
 */

export type PickedVenue = {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
}

type Props = {
  /** The venue currently on the listing, or null. */
  selected: PickedVenue | null
  onSelect: (venue: PickedVenue | null) => void
  /** Shown under the field, from the listing's own validation. */
  error?: string
}

const MIN_QUERY = 2
const DEBOUNCE_MS = 250

export function VenuePicker({ selected, onSelect, error }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<VenueMatch[]>([])
  const [suggestCreate, setSuggestCreate] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [creating, setCreating] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    abortRef.current?.abort()
  }, [])

  /**
   * Debounced, and the previous request is aborted rather than left to land.
   * Without the abort the answer to "pat" can arrive after the answer to
   * "patan" and replace it, which looks exactly like the search ignoring the
   * last two letters typed.
   */
  const search = (value: string) => {
    setQuery(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    abortRef.current?.abort()

    if (value.trim().length < MIN_QUERY) {
      setResults([])
      setSearched(false)
      setSearching(false)
      setSearchFailed(false)
      return
    }

    setSearching(true)
    timerRef.current = setTimeout(() => {
      const controller = new AbortController()
      abortRef.current = controller
      searchVenues(value.trim(), controller.signal)
        .then((body) => {
          setResults(body.data)
          setSuggestCreate(body.suggest_create)
          setSearched(true)
          setSearching(false)
          setSearchFailed(false)
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return
          setSearching(false)
          // A failed search must not replace what the author is typing into
          // with an error page. It says so quietly and the next keystroke
          // retries.
          setSearchFailed(!(cause instanceof AuthorError && cause.code === 'query_too_short'))
          setResults([])
        })
    }, DEBOUNCE_MS)
  }

  const pick = (venue: { id: string; name: string; latitude?: number | null; longitude?: number | null }) => {
    onSelect({
      id: venue.id, name: venue.name,
      latitude: venue.latitude ?? null, longitude: venue.longitude ?? null,
    })
    setQuery('')
    setResults([])
    setSearched(false)
    setCreating(false)
  }

  if (selected) {
    return (
      <div className="venue-picker">
        <div className="venue-picker__chosen">
          <div>
            <span className="venue-picker__chosen-name">{selected.name}</span>
            {selected.latitude !== null && selected.longitude !== null
              ? <span className="venue-picker__chosen-detail">Pinned on the map</span>
              : <span className="venue-picker__chosen-detail">No pin on this venue yet</span>}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onSelect(null)}>
            Change venue
          </Button>
        </div>
        {error && <p className="field__error" role="alert">{error}</p>}
      </div>
    )
  }

  if (creating) {
    return (
      <VenueCreateForm
        initialName={query.trim()}
        onCancel={() => setCreating(false)}
        onCreated={pick}
        onUseExisting={pick}
      />
    )
  }

  return (
    <div className="venue-picker">
      <Field label="Venue" hint="Search what is already in the catalogue" error={error}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} type="search" autoComplete="off"
                 aria-describedby={describedBy} aria-invalid={invalid || undefined}
                 placeholder="Start typing a venue name…"
                 value={query}
                 onChange={(event) => search(event.target.value)} />
        )}
      </Field>

      {searching && <p className="picker__status"><Spinner label="Searching venues" /></p>}

      {searchFailed && (
        <Alert tone="warning" title="Venue search is not answering">
          Keep typing to try again, or add the venue below.
        </Alert>
      )}

      {searched && results.length > 0 && (
        <ul className="venue-picker__results" aria-label="Matching venues">
          {results.map((venue) => (
            <li key={venue.id}>
              <button type="button" className="venue-picker__result" onClick={() => pick(venue)}>
                <span className="venue-picker__result-name">{venue.name}</span>
                <span className="venue-picker__result-where">
                  {[venue.area, venue.city].filter(Boolean).join(', ') || 'Location not recorded'}
                </span>
                {(venue.upcoming_listing_count ?? 0) > 0 && (
                  <Badge tone="accent">{venue.upcoming_listing_count} coming up</Badge>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {searched && results.length === 0 && !searchFailed && (
        <p className="picker__status">Nothing in the catalogue matches “{query.trim()}”.</p>
      )}

      {/* Below the results, never beside the search box. */}
      {(searched || searchFailed) && query.trim().length >= MIN_QUERY && (
        suggestCreate || searchFailed
          ? (
            <Button type="button" variant="secondary" onClick={() => setCreating(true)}>
              Add “{query.trim()}” as a new venue
            </Button>
          )
          : (
            <p className="picker__status">
              That venue is already in the catalogue — pick it from the list above.
            </p>
          )
      )}
    </div>
  )
}

// ── Creating one ─────────────────────────────────────────────────────────────

function VenueCreateForm({ initialName, onCancel, onCreated, onUseExisting }: {
  initialName: string
  onCancel: () => void
  onCreated: (venue: PickedVenue) => void
  onUseExisting: (venue: { id: string; name: string }) => void
}) {
  const [venue, setVenue] = useState<VenueInput>(() => ({ ...emptyVenue(), name: initialName }))
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<{ field: string; message: string }[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicateWarning[] | null>(null)
  const [identical, setIdentical] = useState<{ id: string; name: string } | null>(null)

  const set = (patch: Partial<VenueInput>) => {
    setVenue((current) => ({ ...current, ...patch }))
    // A warning is about the venue as it was when it was raised. Editing any
    // field invalidates it, and leaving it on screen would let the author
    // confirm past a duplicate they have since renamed away from.
    setDuplicates(null)
  }

  const errorFor = (field: string) => errors.find((entry) => entry.field === field)?.message

  const save = async (confirmDuplicate: boolean) => {
    const local = validateVenue(venue)
    if (local.length > 0) {
      setErrors(local)
      setDuplicates(null)
      return
    }
    setErrors([])
    setFailure(null)
    setSaving(true)
    try {
      const created = await createVenue(venue, { confirmDuplicate })
      onCreated({
        id: created.id, name: created.name,
        latitude: created.latitude, longitude: created.longitude,
      })
    } catch (cause) {
      if (cause instanceof DuplicateVenueError) {
        if (cause.code === 'venue_exists' && cause.venue) setIdentical(cause.venue)
        else setDuplicates(cause.duplicates)
      } else if (cause instanceof AuthorError) {
        setErrors(cause.fields)
        setFailure(cause.fields.length > 0 ? null : cause.message)
      } else {
        setFailure('That could not be saved. Try again.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="venue-picker venue-picker--creating">
      <div className="venue-picker__heading">
        <h3 className="venue-picker__title">Add a venue</h3>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Back to search
        </Button>
      </div>

      {identical && (
        <Alert tone="warning" title="That place is already here">
          Google identifies that as “{identical.name}”, which is already in the catalogue.
          {' '}
          <Button type="button" variant="secondary" size="sm"
                  onClick={() => onUseExisting(identical)}>
            Use “{identical.name}”
          </Button>
        </Alert>
      )}

      {duplicates && duplicates.length > 0 && (
        <Alert tone="warning" title="This looks like a venue already in the catalogue">
          <ul className="venue-picker__duplicates">
            {duplicates.map((duplicate) => (
              <li key={duplicate.id}>
                <span className="venue-picker__result-name">{duplicate.name}</span>
                <span className="venue-picker__result-where">
                  {[duplicate.city, duplicate.distance_m !== null
                    ? `${Math.round(duplicate.distance_m)} m away`
                    : null].filter(Boolean).join(' · ')}
                </span>
                <Button type="button" variant="secondary" size="sm"
                        onClick={() => onUseExisting(duplicate)}>
                  Use this one
                </Button>
              </li>
            ))}
          </ul>
          {/* The override is deliberately the plainer button of the two. */}
          <Button type="button" variant="ghost" size="sm" loading={saving}
                  onClick={() => void save(true)}>
            None of these — add it anyway
          </Button>
        </Alert>
      )}

      {failure && <Alert tone="danger" title="Could not save">{failure}</Alert>}

      <div className="wizard__fields">
        <Field label="Name" hint="What people call it, not its legal name"
               error={errorFor('name')}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}
                   value={venue.name} onChange={(event) => set({ name: event.target.value })} />
          )}
        </Field>

        <MapLocationPicker
          label="Where it is"
          lat={venue.latitude} lng={venue.longitude}
          venue={venue}
          onMove={(lat, lng) => set({ latitude: lat, longitude: lng })}
          onGeocoded={(geocoded) => setVenue(geocoded)}
        />

        <Field label="Address" error={errorFor('address')}>
          {({ id, describedBy, invalid }) => (
            <Textarea id={id} rows={2} aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      value={venue.address ?? ''}
                      onChange={(event) => set({ address: event.target.value || null })} />
          )}
        </Field>

        <div className="wizard__pair">
          <Field label="Area" hint="Thamel, Jhamsikhel, Lakeside">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} value={venue.area ?? ''}
                     onChange={(event) => set({ area: event.target.value || null })} />
            )}
          </Field>
          <Field label="City">
            {({ id }) => (
              <Input id={id} value={venue.city ?? ''}
                     onChange={(event) => set({ city: event.target.value || null })} />
            )}
          </Field>
        </div>

        <div className="wizard__pair">
          <Field label="Website" error={errorFor('website_url')}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="url" aria-describedby={describedBy}
                     aria-invalid={invalid || undefined}
                     value={venue.website_url ?? ''}
                     onChange={(event) => set({ website_url: event.target.value || null })} />
            )}
          </Field>
          <Field label="Capacity" hint="Roughly how many fit" error={errorFor('capacity')}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="number" min={1} aria-describedby={describedBy}
                     aria-invalid={invalid || undefined}
                     value={venue.capacity ?? ''}
                     onChange={(event) => set({
                       capacity: event.target.value === '' ? null : Number(event.target.value),
                     })} />
            )}
          </Field>
        </div>
      </div>

      <Button type="button" loading={saving} onClick={() => void save(false)}>
        Save this venue
      </Button>
    </div>
  )
}
