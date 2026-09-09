# Ticket Sanjal scraper

Node 22+ required. This standalone scraper saves JSON; it does not write to NepScene or require Wrangler.

```bash
npm install
npx playwright install chromium
npm run scrape
```

On Linux, if Chromium reports missing system libraries, use `npx playwright install --with-deps chromium`.
For a visible browser: `npm run scrape -- --headed`.

Results go to `ticketsanjal-output/<timestamp>/report.json`:
- `listings`: complete directory cards, unique by event URL.
- `events`: upcoming details with explicit year, date and time.
- `skipped`: archived events, missing/unsupported schedules or past start dates.
- `errors`: detail failures. Nonzero exit and `complete: false` indicate partial results.

The script reads all directory pages and checks the public directory API's `isExpired` flag. Archived events stay in `listings` and `skipped`, but their detail pages are never opened. Only non-archived event details are fetched sequentially. It preserves descriptions, organizer, poster, source price and original card/schedule text (including the venue). Dates are Nepal time. It never guesses the year from image paths or the current year. Some dates can therefore be skipped even when the event appears bookable. Disabled booking buttons do not automatically exclude an event.

Each snapshot has stable `ticketsanjal:<id>` identifiers. This prevents duplicates within the scrape; a future database importer must use those identifiers and cross-source matching to prevent duplicate imports. Running again creates a new snapshot.

Validation: date parsing unit tests and Node syntax checks. The selectors were derived from the live site and a complete 178-card browser scrape. The standalone Playwright script has not been run end-to-end in this environment.

Run tests with `npm test`.
