import { useState } from 'react'
import {
  Alert, Badge, Button, Card, Checkbox, Chip, Field, Input, Modal, Select, Skeleton,
  Spinner, Textarea,
} from '../components/primitives'
import { Tabs } from '../components/Tabs'

/**
 * Every component in every state (#16). This is where a regression in a focus
 * ring or a dark-theme surface is visible without hunting through the product.
 */
export function ComponentGallery() {
  const [modalOpen, setModalOpen] = useState(false)
  const [chipOn, setChipOn] = useState(true)

  return (
    <div className="stack">
      <section>
        <h3>Buttons</h3>
        <div className="row">
          {(['primary', 'secondary', 'ghost', 'danger'] as const).map((variant) => (
            <Button key={variant} variant={variant}>{variant}</Button>
          ))}
        </div>
        <div className="row">
          <Button size="sm">Small</Button>
          <Button>Medium</Button>
          <Button size="lg">Large</Button>
          <Button disabled>Disabled</Button>
          <Button loading>Loading</Button>
        </div>
      </section>

      <section>
        <h3>Form controls</h3>
        <div className="grid-2">
          <Field label="Event name" hint="Shown on the card and the map pin">
            {({ id, describedBy }) => (
              <Input id={id} aria-describedby={describedBy} placeholder="Kathmandu Rock Night" />
            )}
          </Field>
          <Field label="Venue" error="Choose a venue before publishing">
            {({ id, describedBy, invalid }) => (
              <Select id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                <option>Purple Haze Rock Bar</option>
                <option>Patan Durbar Square</option>
              </Select>
            )}
          </Field>
          <Field label="Description">
            {({ id }) => <Textarea id={id} placeholder="What is happening?" />}
          </Field>
          <div className="stack-sm">
            <Checkbox label="Feature on the homepage" defaultChecked />
            <Checkbox label="Free entry" />
            <Checkbox label="Disabled option" disabled />
          </div>
        </div>
      </section>

      <section>
        <h3>Badges and chips</h3>
        <div className="row">
          {(['neutral', 'accent', 'success', 'warning', 'danger'] as const).map((tone) => (
            <Badge key={tone} tone={tone}>{tone}</Badge>
          ))}
        </div>
        <div className="row">
          <Chip pressed={chipOn} onToggle={() => setChipOn(!chipOn)}>Concerts</Chip>
          <Chip>Festivals</Chip>
          <Chip>Food &amp; Drink</Chip>
        </div>
      </section>

      <section>
        <h3>Alerts</h3>
        <div className="stack-sm">
          {(['info', 'success', 'warning', 'danger'] as const).map((tone) => (
            <Alert key={tone} tone={tone} title={tone}>
              A listing may carry an offer. NepScene renders it and never computes it.
            </Alert>
          ))}
        </div>
      </section>

      <section>
        <h3>Surfaces, loading and overlay</h3>
        <div className="grid-2">
          <Card><strong>Flat card</strong><p className="muted">On a raised surface.</p></Card>
          <Card raised><strong>Raised card</strong><p className="muted">With elevation.</p></Card>
        </div>
        <div className="row" style={{ marginTop: 'var(--space-4)' }}>
          <Spinner />
          <Button onClick={() => setModalOpen(true)}>Open dialog</Button>
        </div>
        <div className="stack-sm" style={{ marginTop: 'var(--space-4)', maxWidth: '20rem' }}>
          <Skeleton height="1.5rem" />
          <Skeleton width="70%" />
          <Skeleton width="45%" />
        </div>
      </section>

      <section>
        <h3>Tabs</h3>
        <Tabs
          label="Gallery example"
          tabs={[
            { id: 'upcoming', label: 'Upcoming', content: <p>Bounded and upcoming by default.</p> },
            { id: 'venues', label: 'Venues', content: <p>Canonical entities, not child rows.</p> },
            { id: 'about', label: 'About', content: <p>Arrow keys move between these tabs.</p> },
          ]}
        />
      </section>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Focus is trapped in here"
        footer={
          <div className="row">
            <Button onClick={() => setModalOpen(false)}>Confirm</Button>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancel</Button>
          </div>
        }
      >
        <p>
          Tab cycles inside the dialog, Escape closes it, and focus returns to
          the button that opened it.
        </p>
        <Field label="Something to focus">
          {({ id }) => <Input id={id} placeholder="Try tabbing past the buttons" />}
        </Field>
      </Modal>
    </div>
  )
}
