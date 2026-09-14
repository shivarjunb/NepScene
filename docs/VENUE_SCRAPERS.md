# Kathmandu venue scrapers

Adds 21 validated source profiles to the existing public scraping batch. The registry contains all 183 lead records from the Kathmandu venue list; inclusion in that registry does not imply a working scraper. Taragaon remains handled by its existing importer.

## Run

Node 22 or later; the venue batch requires no additional packages.

```sh
npm run scrape:venues
node scripts/scrape-venues.mjs --source ktm-026,ktm-160 --out scrape-output/selected
node scripts/scrape-venues.mjs --audit --max-pages 25
npm run test:scrapers
```

The default run selects validated profiles. The audit command probes official websites in the entire registry and reports the other leads as reference-only. It can fail when sources block requests, time out or exceed the page limit; completed results are retained. This is bounded discovery, not proof that unsupported sites can never be scraped.

## Results and review

- inventory.json: dated source records, including historical entries, with source identity and original date evidence.
- report.json: normalized draft candidates and exclusion decisions, using the existing Kata Jaam planning conventions. No database comparison, database write or publication occurs. Deduplicate against current database contents before importing.
- review.json: records whose dates or production/show distinction require manual review; these may be historical.
- coverage.json and per-source JSON: pages visited, errors, source status and record counts.

Date-only events retain their dates in the description and inventory and leave the normalized start time unknown. The code does not invent a show time or recurring schedule. Cancelled, explicitly foreign, out-of-area tour listings and past events are excluded where source evidence supports that decision. Source-provided IDs are preferred; fallback identities based on title/date can change after corrections, so imports still need review. Listing-page events receive identity fragments to avoid collapsing separate occurrences sharing one URL. Trailmandu stage details replace matching race overview records.

Parsed means event records were found, not necessarily upcoming events. Empty means an explicit empty calendar was recognized. Partial and failed indicate visible errors; the process returns a failure exit code. Unsupported means no supported event markup was found during the bounded inspection. An enabled source losing expected markup reports a layout/data change rather than silently appearing empty.

## Verified profiles

| ID | Source | Parser | URL |
| --- | --- | --- | --- |
| ktm-003 | International Ethnic Folklore Festival Nepal | ieff | [Source](https://ieffnepal.com/) |
| ktm-009 | Impact Hub Kathmandu | JSON-LD / calendar API | [Source](https://kathmandu.impacthub.net/) |
| ktm-013 | Royal Mountain Travel | royalmt | [Source](https://royalmt.com.np/events-in-nepal/) |
| ktm-016 | Event Manager Nepal | eventmanager | [Source](https://www.eventmanagernepal.com/) |
| ktm-021 | Media Space Solutions | JSON-LD / calendar API | [Source](https://nepalpowerelec.com/) |
| ktm-022 | NADA Automobiles Association of Nepal | nada | [Source](https://nada.org.np/auto-show) |
| ktm-024 | Vihaani Events | vihaani | [Source](https://www.vihaanievents.com/events) |
| ktm-026 | Martin Chautari | chautari | [Source](https://martinchautari.org.np/events) |
| ktm-028 | Pashupati Area Development Trust | pashupati | [Source](https://www.pashupati.gov.np/) |
| ktm-041 | Salsa Nepal | JSON-LD / calendar API | [Source](https://salsanepal.com/) |
| ktm-042 | The Dance Floor | JSON-LD / calendar API | [Source](https://www.thesalsaschool.com/) |
| ktm-048 | HASERA Permaculture Learning Center | hasera | [Source](https://organichasera.org/permaculture-courses/) |
| ktm-073 | Siddhartha Art Gallery | siddhartha | [Source](https://www.siddharthaartgallery.com/) |
| ktm-075 | Takpa Gallery | takpa | [Source](https://takpagallery.com/) |
| ktm-139 | Mandala Theatre Nepal | mandala | [Source](https://bookings.mandalatheatre.com/view-drama/grand-rehearsal) |
| ktm-154 | Trailmandu Nepal | JSON-LD / calendar API | [Source](https://www.race.trailmandu.com/) |
| ktm-156 | Happy Club | happyclub | [Source](https://happyclub.com.np/shows/) |
| ktm-160 | Paleti / Nepalaya | paleti | [Source](https://paleti.com.np/) |
| ktm-165 | KathaSatha | kathasatha | [Source](https://www.kathasatha.org/events) |
| ktm-169 | Kopan Monastery | kopan | [Source](https://kopanmonastery.org/) |
| ktm-170 | Art of Living Nepal | artofliving | [Source](https://www.artofliving.org/np-en/course-details-sudarshan-kriya) |

Mandala currently yields production information for review, not individual bookable performances. Salsa Nepal and The Dance Floor currently return empty calendars. Chautari uses listing datetimes; some listings lack venue and poster metadata. Art of Living covers the configured published course page, not every course registration. Pashupati reads the dated programme without extrapolating future days. Royal Mountain Travel filters published festival outings to named Valley and nearby locations. Nearby resorts, homestays and other leads without usable calendars remain in the audit for telephone/social follow-up.

## Validation and operation

51 native Node tests pass, including pagination, partial failures, date validation, captured source markup, identity handling, and the existing import planner/database tests. Public live checks on 2026-09-11 reached all 21 enabled profiles: 19 parsed and 2 explicitly empty. The combined snapshot contains 138 raw dated records and 25 draft insert candidates before database comparison, plus 3 manual-review records. Counts are a dated snapshot and will change.

The full audit is in [venue-source-audit.csv](venue-source-audit.csv). Original discovery inspected 100 official-site lead links (98 domains), followed by additional event pages. Disabled rows retain the bounded audit result rather than an assertion that no events exist.

Requests use a descriptive User-Agent, same-site URL/redirect restrictions, four source workers, per-source pacing, timeouts, limited retries, a 3 MB response cap and a page cap. No login or browser challenge bypass is implemented. Confirm source access policies before increasing crawl frequency. The existing daily workflow runs the batch in scrape-only mode and retains partial results as artifacts; it becomes active only after these changes reach the default branch.
