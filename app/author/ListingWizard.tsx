import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  emptyListing, stepsFor, validateStep, validateListing, WIZARD_STEPS,
  type ListingInput, type StepId,
} from '../../api/author/validate'
import { Alert, Button, Card, Spinner } from '../components/primitives'
import {
  AuthorError, fetchListing, fetchLookups, publishListing, submitListing,
  type Account, type Lookups, type SavedListing,
} from '../lib/author'
import { navigate } from '../router'
import { browserStorage, clearDraft, isWorthRecovering, loadDraft, type StoredDraft } from './draftStore'
import { useDraft } from './useDraft'
import {
  AppearanceStep, DetailsStep, MediaStep, ReviewStep, WhenStep, WhereStep,
} from './steps'

/**
 * The listing creation wizard (#30) — the WaahTickets `CreateEventWizard` with
 * its commerce half removed and autosave added.
 *
 * What survived the port: the step model, per-step validation, and edit mode.
 * What did not: ticket types and coupons, which were steps 3 and 4 there and
 * most of its 1,207 lines. What is new: draft recovery, and lookups arriving in
 * one request rather than a waterfall.
 */

type Props = { account: Account; listingId: string | null }

/** Which step a given field lives on, so an error can send the author to it. */
const STEP_FOR_FIELD: Record<string, StepId> = {
  title: 'details', listing_type: 'details', summary: 'details', description: 'details',
  external_url: 'details', offer_url: 'details', category_slugs: 'details',
  primary_category_slug: 'details', tags: 'details', organization_id: 'details',
  starts_at: 'when', ends_at: 'when', timezone: 'when', is_all_day: 'when',
  venue_id: 'where', location_lat: 'where', location_lng: 'where',
}

export function ListingWizard({ account, listingId: initialId }: Props) {
  /**
   * The id this wizard opened with, frozen.
   *
   * Autosave rewrites the URL the moment the draft first saves, which sends a
   * new `listingId` prop down from the route. Treating that as "open a
   * different listing" would re-run the load below against the listing we just
   * created — refetching the lookups, and offering to recover the local draft
   * the author is still typing into. The wizard owns its id from here on;
   * `listingId` state is the live one.
   */
  const [bootId] = useState(initialId)
  const [listingId, setListingId] = useState<string | null>(initialId)
  const [listing, setListing] = useState<ListingInput>(emptyListing)
  const [step, setStep] = useState<StepId>('details')
  /**
   * How far the author has got, which is what the rail lets them jump back to.
   * A listing loaded from the server starts fully unlocked: its steps have all
   * been filled in already, and making someone press Next five times to reach
   * Review in order to change one word is not editing, it is re-entry.
   */
  const [furthest, setFurthest] = useState(0)
  const [lookups, setLookups] = useState<Lookups | null>(null)
  const [media, setMedia] = useState<SavedListing['media']>([])
  const [status, setStatus] = useState<SavedListing['status']>('draft')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [recoverable, setRecoverable] = useState<StoredDraft | null>(null)
  /** Errors are only shown once the author has tried to leave a step. */
  const [showErrors, setShowErrors] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitErrors, setSubmitErrors] = useState<{ field: string; message: string }[]>([])
  const [published, setPublished] = useState<string | null>(null)

  const storage = useMemo(() => browserStorage(), [])
  const headingRef = useRef<HTMLHeadingElement>(null)

  const canPublish = account.permissions.includes('listing:publish')

  // ── Load ──────────────────────────────────────────────────────────────────
  // Lookups and the listing go out together. Awaiting one before starting the
  // other is exactly the waterfall #30 exists to remove, and it is the easiest
  // one to reintroduce by accident.
  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [lookupData, saved] = await Promise.all([
          fetchLookups(),
          bootId ? fetchListing(bootId) : Promise.resolve(null),
        ])
        if (cancelled) return

        setLookups(lookupData)
        if (saved) {
          setListing(saved.listing)
          setMedia(saved.media)
          setStatus(saved.status)
          setFurthest(stepsFor(saved.listing.listing_type).length - 1)
        }

        // A local draft newer than what the server holds means the last tab
        // closed before its save landed. Offer it rather than restoring it
        // silently: the author is the only one who knows which is right.
        const local = loadDraft(storage, bootId)
        if (local && isWorthRecovering(local)
            && (!saved || local.savedAt > saved.updated_at)) {
          setRecoverable(local)
        }
      } catch (error) {
        if (cancelled) return
        setLoadError(error instanceof AuthorError ? error.message : 'Could not load the wizard')
      }
    }

    void load()
    return () => { cancelled = true }
  }, [bootId, storage])

  // ── Autosave ──────────────────────────────────────────────────────────────
  const onCreated = useCallback((id: string) => {
    setListingId(id)
    // The URL becomes the draft's address, so a reload lands back on it rather
    // than starting a second empty listing.
    navigate(`/submit/${id}`, { replace: true })
  }, [])

  const { state: saveState, saveNow } = useDraft({
    listing, step, listingId, onCreated, storage,
    // Nothing saves until the lookups are in, or the first autosave would race
    // the load and write an empty listing over a real one.
    enabled: lookups !== null && recoverable === null && published === null,
  })

  // ── Steps ─────────────────────────────────────────────────────────────────
  const steps = stepsFor(listing.listing_type)
  const index = Math.max(0, steps.indexOf(step))

  // A type change can remove the step the author is standing on — choosing
  // "announcement" while on "where" is the obvious case.
  useEffect(() => {
    if (!steps.includes(step)) setStep(steps[0] ?? 'details')
  }, [steps, step])

  const stepErrors = validateStep(step, listing)
  const allErrors = validateListing(listing)

  const goTo = useCallback((next: StepId) => {
    setStep(next)
    setFurthest((reached) => Math.max(reached, stepsFor(listing.listing_type).indexOf(next)))
    setShowErrors(false)
    // A client-side step change moves nothing for a screen reader unless focus
    // moves with it, the same reason the router moves focus on navigation.
    requestAnimationFrame(() => headingRef.current?.focus())
  }, [listing.listing_type])

  function next() {
    if (stepErrors.length > 0) {
      setShowErrors(true)
      requestAnimationFrame(() => headingRef.current?.focus())
      return
    }
    const target = steps[index + 1]
    if (target) goTo(target)
  }

  function back() {
    const target = steps[index - 1]
    if (target) goTo(target)
  }

  function jumpToField(field: string) {
    const target = STEP_FOR_FIELD[field]
    if (target && steps.includes(target)) {
      goTo(target)
      setShowErrors(true)
    }
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function send() {
    if (!listingId) return
    setSubmitting(true)
    setSubmitErrors([])
    try {
      // The pending debounce is flushed first: submitting what the server holds
      // rather than what is on screen is how an author sends a listing missing
      // the last thing they typed.
      await saveNow()
      const submitted = await submitListing(listingId)
      setStatus('pending_review')

      // An editor publishes in the same motion rather than queueing work for
      // themselves; an organizer's listing waits for one.
      if (canPublish) {
        const result = await publishListing(submitted.id)
        setStatus('published')
        setPublished(result.slug)
      }
      clearDraft(storage, listingId)
      clearDraft(storage, null)
    } catch (error) {
      if (error instanceof AuthorError && error.code === 'incomplete_listing') {
        setSubmitErrors(error.fields)
        const first = error.fields[0]
        if (first) jumpToField(first.field)
      } else {
        setSubmitErrors([{
          field: 'form',
          message: error instanceof Error ? error.message : 'That did not work',
        }])
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadError) {
    return <Alert tone="danger" title="Something went wrong">{loadError}</Alert>
  }

  if (!lookups) {
    return <div className="wizard__loading"><Spinner label="Loading the wizard" /></div>
  }

  if (published) {
    return (
      <Card raised>
        <h1>Published</h1>
        <p>Your listing is live and on the map.</p>
        <Button onClick={() => navigate(`/listings/${published}`)}>See it</Button>
      </Card>
    )
  }

  if (status === 'pending_review') {
    return (
      <Card raised>
        <h1>Sent for review</h1>
        <p>
          An editor will look at it shortly. Nothing is public until one of them
          publishes it.
        </p>
        <Button variant="secondary" onClick={() => navigate('/')}>Back to the catalogue</Button>
      </Card>
    )
  }

  const set = (patch: Partial<ListingInput>) =>
    setListing((current) => ({ ...current, ...patch }))

  const visibleErrors = showErrors ? stepErrors : []
  const stepTitle = WIZARD_STEPS.find((s) => s.id === step)?.title ?? ''

  return (
    <div className="wizard">
      {recoverable && (
        <RecoveryPrompt
          draft={recoverable}
          onRestore={() => {
            setListing(recoverable.listing)
            if (steps.includes(recoverable.step as StepId)) setStep(recoverable.step as StepId)
            setRecoverable(null)
          }}
          onDiscard={() => {
            clearDraft(storage, bootId)
            setRecoverable(null)
          }}
        />
      )}

      <ol className="wizard__steps">
        {steps.map((id, position) => {
          const title = WIZARD_STEPS.find((s) => s.id === id)?.title ?? id
          const state = position === index ? 'current' : position < index ? 'done' : 'todo'
          const reachable = position <= Math.max(index, furthest)
          return (
            <li key={id} className={`wizard__step wizard__step--${state}`}>
              {/*
                Every visited step is a real button, so going back three steps to
                fix a typo does not mean pressing Back three times.
              */}
              <button type="button" onClick={() => goTo(id)}
                      aria-current={position === index ? 'step' : undefined}
                      disabled={!reachable}>
                <span className="wizard__step-number" aria-hidden="true">{position + 1}</span>
                {title}
              </button>
            </li>
          )
        })}
      </ol>

      <Card>
        <h1 className="wizard__heading" tabIndex={-1} ref={headingRef}>
          {stepTitle}
          <span className="visually-hidden"> — step {index + 1} of {steps.length}</span>
        </h1>

        {visibleErrors.length > 0 && (
          <Alert tone="danger" title="Have another look at this">
            <ul className="wizard__error-list">
              {visibleErrors.map((error) => (
                <li key={`${error.field}-${error.message}`}>{error.message}</li>
              ))}
            </ul>
          </Alert>
        )}

        {submitErrors.length > 0 && (
          <Alert tone="danger" title="Not ready to send">
            <ul className="wizard__error-list">
              {submitErrors.map((error) => (
                <li key={`${error.field}-${error.message}`}>{error.message}</li>
              ))}
            </ul>
          </Alert>
        )}

        {step === 'details' && (
          <DetailsStep listing={listing} set={set} lookups={lookups} errors={visibleErrors} />
        )}
        {step === 'when' && (
          <WhenStep listing={listing} set={set} lookups={lookups} errors={visibleErrors} />
        )}
        {step === 'where' && (
          <WhereStep listing={listing} set={set} lookups={lookups} errors={visibleErrors} />
        )}
        {step === 'media' && (
          <MediaStep listingId={listingId} media={media} onUploaded={() => {
            if (listingId) void fetchListing(listingId).then((saved) => setMedia(saved.media))
          }} />
        )}
        {step === 'appearance' && <AppearanceStep listing={listing} lookups={lookups} />}
        {step === 'review' && (
          <ReviewStep listing={listing} set={set} lookups={lookups}
                      errors={allErrors} onJump={jumpToField} />
        )}

        <div className="wizard__actions">
          <Button variant="ghost" onClick={back} disabled={index === 0}>Back</Button>
          <SaveIndicator state={saveState} />
          {step === 'review' ? (
            <Button onClick={send} loading={submitting}
                    disabled={allErrors.length > 0 || !listingId}>
              {canPublish ? 'Publish' : 'Send for review'}
            </Button>
          ) : (
            <Button onClick={next}>Next</Button>
          )}
        </div>
      </Card>
    </div>
  )
}

/**
 * Autosave is only reassuring if it is visible. `role="status"` rather than an
 * alert: "Saved" every few seconds through an assertive channel would make the
 * form unusable with a screen reader.
 */
function SaveIndicator({ state }: { state: ReturnType<typeof useDraft>['state'] }) {
  return (
    <span className="wizard__save" role="status">
      {state.status === 'saving' && 'Saving…'}
      {state.status === 'saved' && 'Saved'}
      {state.status === 'error' && <span className="wizard__save--error">{state.message}</span>}
    </span>
  )
}

function RecoveryPrompt({ draft, onRestore, onDiscard }: {
  draft: StoredDraft; onRestore: () => void; onDiscard: () => void
}) {
  const when = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    .format(new Date(draft.savedAt))

  return (
    <Alert tone="warning" title="You have unsaved work on this device">
      <p>
        {draft.listing.title
          ? <>“{draft.listing.title}”, last edited {when}.</>
          : <>An untitled listing, last edited {when}.</>}
      </p>
      <div className="wizard__actions">
        <Button size="sm" onClick={onRestore}>Pick up where I left off</Button>
        <Button size="sm" variant="ghost" onClick={onDiscard}>Discard it</Button>
      </div>
    </Alert>
  )
}
