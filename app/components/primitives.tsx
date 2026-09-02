import { forwardRef, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes,
         type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '../hooks/useFocusTrap'

/**
 * The primitives (#16). Every one is keyboard operable, carries the shared
 * focus ring, and reads its colours from tokens so both themes come free.
 */

// ── Button ──────────────────────────────────────────────────────────────────
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', block, loading, children, className, disabled, ...rest }, ref,
) {
  const classes = [
    'btn', `btn--${variant}`,
    size !== 'md' ? `btn--${size}` : '',
    block ? 'btn--block' : '', className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <button ref={ref} className={classes} disabled={disabled || loading}
            aria-busy={loading || undefined} {...rest}>
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  )
})

// ── Field wrapper ───────────────────────────────────────────────────────────
type FieldProps = {
  label: string
  hint?: string
  error?: string
  children: (props: { id: string; describedBy?: string; invalid: boolean }) => ReactNode
}

/**
 * Every control is labelled and every hint and error is announced. Passing the
 * ids down rather than guessing them is what makes that reliable.
 */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>{label}</label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && <span className="field__hint" id={hintId}>{hint}</span>}
      {error && <span className="field__error" id={errorId} role="alert">{error}</span>}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={`field__control ${className ?? ''}`} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={`field__control ${className ?? ''}`} {...rest} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={`field__control ${className ?? ''}`} {...rest}>{children}</select>
    )
  },
)

export function Checkbox({ label, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="checkbox">
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  )
}

// ── Surfaces ────────────────────────────────────────────────────────────────
export function Card({ children, raised, className }: {
  children: ReactNode; raised?: boolean; className?: string
}) {
  return (
    <div className={`card ${raised ? 'card--raised' : 'card--flat'} ${className ?? ''}`}>
      {children}
    </div>
  )
}

export function Badge({ tone = 'neutral', children }: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; children: ReactNode
}) {
  return <span className={`badge ${tone !== 'neutral' ? `badge--${tone}` : ''}`}>{children}</span>
}

export function Chip({ pressed, onToggle, children }: {
  pressed?: boolean; onToggle?: () => void; children: ReactNode
}) {
  return (
    <button type="button" className="chip" aria-pressed={pressed} onClick={onToggle}>
      {children}
    </button>
  )
}

export function Alert({ tone = 'info', title, children }: {
  tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children: ReactNode
}) {
  return (
    // Errors and warnings interrupt; information waits its turn.
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <div>
        {title && <div className="alert__title">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  )
}

export function Skeleton({ width = '100%', height = '1rem' }: { width?: string; height?: string }) {
  return <div className="skeleton" style={{ width, height }} aria-hidden="true" />
}

// ── Modal ───────────────────────────────────────────────────────────────────
export function Modal({ open, onClose, title, children, footer }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useFocusTrap(dialogRef, open, onClose)

  if (!open) return null

  return createPortal(
    <div className="modal__scrim" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true"
           aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal__header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">✕</Button>
        </div>
        {children}
        {footer && <div style={{ marginTop: 'var(--space-5)' }}>{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
