# Scope

## The one-sentence test

> Does this help someone find out what is happening in Nepal?

If yes, it belongs here. If it helps someone *pay* for what is happening, it belongs
in WaahTickets.

## In scope

### Listings
Events of every kind, including ones NepScene cannot sell. A listing has a type:

| `listing_type` | Meaning | Example |
|---|---|---|
| `ticketed_internal` | Sold by WaahTickets | A concert with tiered tickets |
| `ticketed_external` | Sold elsewhere, we link out | A festival selling on its own site |
| `free` | No ticket needed | A community cleanup, a temple festival |
| `announcement` | Informational, no attendance model | A venue reopening |

And a provenance, because a catalogue that anyone can write to needs to know who
wrote what:

| `source` | Meaning |
|---|---|
| `organizer` | Created by a verified organizer account |
| `submission` | Submitted by the public, moderated before publishing |
| `import` | Ingested from an external feed |
| `editorial` | Created by the NepScene team |

### Event authoring
Enough of the WaahTickets creation wizard to describe an event and put it on the
map: name, description, category, date and time, venue and coordinates, banner
image, map pin appearance, publish state.

### Discovery
The map, the feed, search, filters, category and city browsing, event and venue and
organizer detail pages, and the SEO surface that makes any of it findable.

### Identity
Accounts, sign-in, and roles: visitor, organizer, editor, admin. Only as much as
authoring and moderation require.

## Out of scope

Not "later" — **not in this product**:

- carts, checkout, payment gateways
- orders, order items, payments
- tickets, QR codes, PDFs, wallets, scanning, validation
- coupons, discounts, promotional pricing
- commissions, referrals, sales agents
- refunds, payouts, settlement, financial reporting
- seat maps and reserved seating

## The seam: offers

A listing may carry an offer, which NepScene **renders but never computes**:

```
offer = {
  purchasable: boolean
  price_from: integer | null   # paisa, display only
  currency: string
  url: string                  # WaahTickets, or a third party
  provider: 'waahtickets' | 'external'
  sold_out: boolean
}
```

NepScene must degrade gracefully when offers cannot be resolved: render the listing
without the offer rather than failing the page. Discovery does not depend on
commerce being up.

## Guardrails

Three rules that keep the boundary from eroding:

1. **No NepScene table stores money that a transaction depends on.** A cached
   display price is fine; anything a payment is computed from is not.
2. **No NepScene endpoint writes to a commerce table.** Reading a resolved offer is
   the only permitted direction.
3. **A feature that needs a server-side price authority is in the wrong repo.**
