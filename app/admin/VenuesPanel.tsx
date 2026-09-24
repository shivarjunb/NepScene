import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert, Badge, Button, Card, Checkbox, Field, Input, Modal, Spinner } from '../components/primitives'
import { AuthorError } from '../lib/author'
import {
  fetchVenues, mergeVenue, updateVenue,
  type AdminVenue, type VenueChange, type VenueFilter, type VenueList,
} from '../lib/admin'
import { Link, useSearch } from '../router'
import { Pager } from './shared'

/**
 * Venues: fix the details, put them on the map, fold duplicates together.
 *
 * Every listing at a venue inherits its name and its pin, so one venue with
 * no pin is several listings the map cannot show, and one venue named
 * "purple haze" is every card that says so. The two filters are the two
 * kinds of untidy that matter — no pin, and not yet checked by a person —
 * and each shows how many there are before it is clicked.
 *
 * Editing and merging are dialogs over the list, so the list keeps its
 * search and its page while one venue is being fixed.
 */

const FILTERS: { value: VenueFilter | ''; label: string; count: keyof VenueList['counts'] }[] = [
  { value: '', label: 'All', count: 'all' },
  { value: 'unmapped', label: 'No map pin', count: 'unmapped' },
  { value: 'unverified', label: 'Not verified', count: 'unverified' },
]

export function VenuesPanel() {
  const [query, setQuery] = useState('')
  // The overview's "fix the ones with no pin" lands on that filter.
  const asked = useSearch().get('filter')
  const [filter, setFilter] = useState<VenueFilter | ''>(
    asked === 'unmapped' || asked === 'unverified' ? asked : '',
  )
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<VenueList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editing, setEditing] = useState<AdminVenue | null>(null)
  const [merging, setMerging] = useState<AdminVenue | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setList(await fetchVenues({ q: query.trim(), filter: filter || undefined, offset }))
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The venues did not load')
    } finally {
      setLoading(false)
    }
  }, [query, filter, offset])

  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, query])

  const rows = list?.data ?? []

  return (
    <section className="admin__section" aria-labelledby="admin-heading">
      {note && <Alert tone="success" title="Done">{note}</Alert>}
      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <div className="board__controls">
        <nav className="board__tabs" aria-label="Venues by state">
          {FILTERS.map((option) => (
            <button key={option.value} type="button"
                    className={`queue__tab${filter === option.value ? ' is-current' : ''}`}
                    aria-current={filter === option.value ? 'true' : undefined}
                    onClick={() => { setFilter(option.value); setOffset(0) }}>
              {option.label} <span className="queue__count">{list?.counts[option.count] ?? 0}</span>
            </button>
          ))}
        </nav>

        <Field label="Find a venue">
          {({ id }) => (
            <Input id={id} type="search" placeholder="Name, area or city…" value={query}
                   onChange={(event) => { setQuery(event.target.value); setOffset(0) }} />
          )}
        </Field>
      </div>

      {loading && !list && <div className="wizard__loading"><Spinner label="Loading venues" /></div>}

      {!loading && rows.length === 0 && (
        <Card><p className="queue__empty">No venue matches.</p></Card>
      )}

      {rows.length > 0 && (
        <ul className="admin__list" aria-busy={loading}>
          {rows.map((venue) => {
            const pinned = venue.latitude !== null && venue.longitude !== null
            return (
              <li key={venue.id}>
                <Card className="admin__row">
                  <div className="admin__row-body">
                    <h2 className="admin__row-title">
                      {venue.name}
                      {venue.is_verified && <Badge tone="success">verified</Badge>}
                      {!pinned && <Badge tone="warning">no map pin</Badge>}
                    </h2>
                    <p className="board__meta">
                      {[venue.address, venue.area, venue.city].filter(Boolean).join(', ') || 'No address'}
                    </p>
                    <p className="board__meta">
                      {venue.listing_count} {venue.listing_count === 1 ? 'listing' : 'listings'}
                      {' · '}{venue.published_count} published
                    </p>
                  </div>
                  <div className="admin__row-actions">
                    <Link className="btn btn--ghost btn--sm" href={`/venues/${venue.slug}`}>View</Link>
                    <Button type="button" size="sm" variant="secondary" onClick={() => setMerging(venue)}>
                      Merge…
                    </Button>
                    <Button type="button" size="sm" onClick={() => setEditing(venue)}>Edit</Button>
                  </div>
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      {list && <Pager page={list.page} count={rows.length} onPage={setOffset} />}

      {editing && (
        <VenueEditor venue={editing} onClose={() => setEditing(null)}
                     onSaved={(saved) => {
                       setEditing(null)
                       setNote(`${saved.name} is saved.`)
                       setList((current) => current && {
                         ...current, data: current.data.map((row) => (row.id === saved.id ? saved : row)),
                       })
                     }} />
      )}

      {merging && (
        <VenueMerger venue={merging} onClose={() => setMerging(null)}
                     onMerged={(into, moved) => {
                       setMerging(null)
                       setNote(`${merging.name} is merged into ${into.name}; ${moved} ${moved === 1 ? 'listing' : 'listings'} moved.`)
                       void load()
                     }} />
      )}
    </section>
  )
}

type Draft = Record<'name' | 'address' | 'area' | 'city' | 'latitude' | 'longitude' | 'website_url' | 'phone', string>

const toDraft = (venue: AdminVenue): Draft => ({
  name: venue.name,
  address: venue.address ?? '',
  area: venue.area ?? '',
  city: venue.city ?? '',
  latitude: venue.latitude === null ? '' : String(venue.latitude),
  longitude: venue.longitude === null ? '' : String(venue.longitude),
  website_url: venue.website_url ?? '',
  phone: venue.phone ?? '',
})

const LABELS: Record<keyof Draft, string> = {
  name: 'Name', address: 'Address', area: 'Area', city: 'City',
  latitude: 'Latitude', longitude: 'Longitude', website_url: 'Website', phone: 'Phone',
}

/**
 * The venue's details as a form. The server validates with the wizard's own
 * rules and answers per field, so an error lands under the box it is about.
 */
function VenueEditor({ venue, onClose, onSaved }: {
  venue: AdminVenue
  onClose: () => void
  onSaved: (venue: AdminVenue) => void
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(venue))
  const [verified, setVerified] = useState(venue.is_verified)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setFields({})
    const text = (value: string) => value.trim() || null
    const coordinate = (value: string) => (value.trim() === '' ? null : Number(value))
    const change: VenueChange = {
      name: draft.name.trim(),
      address: text(draft.address),
      area: text(draft.area),
      city: text(draft.city),
      latitude: coordinate(draft.latitude),
      longitude: coordinate(draft.longitude),
      website_url: text(draft.website_url),
      phone: text(draft.phone),
      is_verified: verified,
    }
    try {
      onSaved(await updateVenue(venue.id, change))
    } catch (caught) {
      if (caught instanceof AuthorError) {
        setError(caught.message)
        setFields(Object.fromEntries(caught.fields.map((field) => [field.field, field.message])))
      } else {
        setError('That did not save')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open title={`Edit ${venue.name}`} onClose={onClose}>
      <form className="admin__venue-form" onSubmit={(event) => void save(event)} noValidate>
        {error && <Alert tone="danger" title="Not saved">{error}</Alert>}
        {(Object.keys(LABELS) as (keyof Draft)[]).map((key) => (
          <Field key={key} label={LABELS[key]} error={fields[key]}
                 hint={key === 'latitude' ? 'Both, or neither: a pin needs a latitude and a longitude' : undefined}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} value={draft[key]} aria-describedby={describedBy} aria-invalid={invalid}
                     inputMode={key === 'latitude' || key === 'longitude' ? 'decimal' : undefined}
                     type={key === 'website_url' ? 'url' : 'text'}
                     onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} />
            )}
          </Field>
        ))}
        <Checkbox label="Verified — a person has checked this venue is real and where the pin says"
                  checked={verified} onChange={(event) => setVerified(event.target.checked)} />
        <div className="admin__form-actions">
          <Button type="submit" loading={busy}>Save</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * Pick the venue this one duplicates, then confirm. The survivor keeps its
 * own name, slug and pin; everything listed at the duplicate moves to it.
 */
function VenueMerger({ venue, onClose, onMerged }: {
  venue: AdminVenue
  onClose: () => void
  onMerged: (into: AdminVenue, moved: number) => void
}) {
  const [query, setQuery] = useState(venue.name)
  const [options, setOptions] = useState<AdminVenue[]>([])
  const [target, setTarget] = useState<AdminVenue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchVenues({ q: query.trim(), limit: 8 })
        .then((found) => setOptions(found.data.filter((row) => row.id !== venue.id)))
        .catch(() => setOptions([]))
    }, 250)
    return () => clearTimeout(timer)
  }, [query, venue.id])

  const merge = async () => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const result = await mergeVenue(venue.id, target.id)
      onMerged(target, result.moved)
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The merge did not work')
      setBusy(false)
    }
  }

  return (
    <Modal open title={`Merge ${venue.name} into…`} onClose={onClose}>
      <div className="admin__venue-form">
        <p className="board__meta">
          Its {venue.listing_count} {venue.listing_count === 1 ? 'listing moves' : 'listings move'} to the venue
          you pick, and {venue.name} is deleted. This cannot be undone from here.
        </p>
        {error && <Alert tone="danger" title="Not merged">{error}</Alert>}
        <Field label="Find the venue it duplicates">
          {({ id }) => (
            <Input id={id} type="search" value={query}
                   onChange={(event) => { setQuery(event.target.value); setTarget(null) }} />
          )}
        </Field>
        <fieldset className="admin__merge-options">
          <legend className="visually-hidden">Venues to merge into</legend>
          {options.length === 0 && <p className="board__meta">No other venue matches.</p>}
          {options.map((option) => (
            <label key={option.id} className="admin__merge-option">
              <input type="radio" name="merge-into" checked={target?.id === option.id}
                     onChange={() => setTarget(option)} />
              <span>
                <strong>{option.name}</strong>
                <span className="board__meta">
                  {' '}{[option.area, option.city].filter(Boolean).join(', ')}
                  {' · '}{option.listing_count} {option.listing_count === 1 ? 'listing' : 'listings'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="admin__form-actions">
          <Button type="button" variant="danger" loading={busy} disabled={!target} onClick={() => void merge()}>
            {target ? `Merge into ${target.name}` : 'Pick a venue'}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}
