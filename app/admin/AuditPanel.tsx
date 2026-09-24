import { useCallback, useEffect, useState } from 'react'
import { Alert, Card, Field, Select, Spinner } from '../components/primitives'
import { AuthorError } from '../lib/author'
import { ENTITY_TYPES, fetchAudit, type AuditList, type EntityType } from '../lib/admin'
import { AuditRow, Pager } from './shared'

/**
 * The audit trail (#20): everything anyone did, newest first.
 *
 * Filtered by what kind of thing, because "what happened to the users?" and
 * "what happened to the listings?" are different afternoons. Filtering by
 * who is a link from a row rather than a box here — an admin arrives at
 * "what did this person do?" from the person, not from the log.
 */
export function AuditPanel() {
  const [entityType, setEntityType] = useState<EntityType | ''>('')
  const [offset, setOffset] = useState(0)
  const [list, setList] = useState<AuditList | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (which: EntityType | '', from: number) => {
    setLoading(true)
    setError(null)
    try {
      setList(await fetchAudit({ entity_type: which || undefined, offset: from, limit: 50 }))
    } catch (caught) {
      setError(caught instanceof AuthorError ? caught.message : 'The audit trail did not load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(entityType, offset) }, [entityType, offset, load])

  const rows = list?.data ?? []

  return (
    <section className="admin__section" aria-labelledby="admin-heading">

      {error && <Alert tone="danger" title="Something went wrong">{error}</Alert>}

      <div className="board__controls">
        <Field label="Show changes to">
          {({ id }) => (
            <Select id={id} value={entityType}
                    onChange={(event) => { setEntityType(event.target.value as EntityType | ''); setOffset(0) }}>
              <option value="">Everything</option>
              {ENTITY_TYPES.map((type) => <option key={type} value={type}>{type}s</option>)}
            </Select>
          )}
        </Field>
      </div>

      {loading && <div className="wizard__loading"><Spinner label="Loading the audit trail" /></div>}

      {!loading && rows.length === 0 && (
        <Card><p className="queue__empty">Nothing recorded yet.</p></Card>
      )}

      {rows.length > 0 && (
        <Card className="admin__audit">
          {rows.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
        </Card>
      )}

      {list && <Pager page={list.page} count={rows.length} onPage={setOffset} />}
    </section>
  )
}
