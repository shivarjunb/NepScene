-- Demo catalogue (#26) — realistic enough to develop and demo against.
--
-- Dates are relative to `now`, so the seed stays useful whenever it is run:
-- a fixed-date seed is a catalogue full of finished events a week later, which
-- is exactly the failure the Catalog API exists to avoid.
--
-- Covers, on purpose: all four listing types, all four sources, a draft and a
-- pending-review listing that must never appear in public reads, two listings
-- at one venue (map grouping), a listing with coordinates that differ from its
-- venue, a listing with no venue, a finished event, and a renamed slug.

DELETE FROM slug_redirects;
DELETE FROM listing_artists;
DELETE FROM listing_categories;
DELETE FROM listing_media;
DELETE FROM listings;
DELETE FROM artists;
DELETE FROM venues;
DELETE FROM organizations;

INSERT INTO organizations (id, slug, name, description, website_url, is_verified, created_at, updated_at) VALUES
  ('org_himalayan', 'himalayan-sound', 'Himalayan Sound', 'Live music promoters working out of Kathmandu since 2014.', 'https://example.np/himalayan-sound', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('org_lakeside',  'lakeside-collective', 'Lakeside Collective', 'Pokhara-based arts and food collective.', NULL, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('org_nepscene',  'nepscene-editorial', 'NepScene Editorial', 'Listings researched and written by the NepScene team.', NULL, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

INSERT INTO venues (id, slug, name, description, address, area, city, district, province, latitude, longitude, capacity, is_verified, created_at, updated_at) VALUES
  ('ven_purple',   'purple-haze-rock-bar', 'Purple Haze Rock Bar', 'Thamel''s long-running live rock venue.', 'Thamel Marg', 'Thamel', 'Kathmandu', 'Kathmandu', 'Bagmati', 27.7154, 85.3105, 400, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ven_patan',    'patan-durbar-square', 'Patan Durbar Square', 'UNESCO world heritage square in the heart of Lalitpur.', 'Patan Durbar Sq', 'Mangal Bazaar', 'Lalitpur', 'Lalitpur', 'Bagmati', 27.6727, 85.3255, NULL, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ven_dashrath', 'dashrath-stadium', 'Dashrath Rangasala', 'The national stadium at Tripureshwor.', 'Tripureshwor', 'Tripureshwor', 'Kathmandu', 'Kathmandu', 'Bagmati', 27.6926, 85.3122, 15000, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ven_lakeside', 'lakeside-pokhara',     'Lakeside, Phewa Tal', 'The strip along Phewa lake.', 'Lakeside Rd', 'Baidam', 'Pokhara', 'Kaski', 'Gandaki', 28.2096, 83.9556, NULL, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ven_bhaktapur','bhaktapur-durbar-square', 'Bhaktapur Durbar Square', 'The old royal palace complex.', 'Durbar Sq', 'Bhaktapur', 'Bhaktapur', 'Bhaktapur', 'Bagmati', 27.6722, 85.4283, NULL, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('ven_sauraha',  'sauraha-chitwan',      'Sauraha', 'Gateway to Chitwan National Park.', 'Sauraha', 'Sauraha', 'Bharatpur', 'Chitwan', 'Bagmati', 27.5786, 84.4980, NULL, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

INSERT INTO artists (id, slug, name, bio, created_at, updated_at) VALUES
  ('art_1974ad',   '1974-ad',      '1974 AD', 'Nepali rock band formed in Kathmandu in 1994.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('art_bipul',    'bipul-chettri','Bipul Chettri', 'Singer-songwriter from Kalimpong.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('art_kutumba',  'kutumba',      'Kutumba', 'Instrumental folk ensemble.', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

-- ─── Listings ────────────────────────────────────────────────────────────────
INSERT INTO listings
  (id, slug, title, summary, description, listing_type, source, status,
   organization_id, venue_id, starts_at, ends_at, is_all_day, cover_image_url,
   external_url, offer_url, offer_provider, offer_price_from_paisa, offer_sold_out,
   location_lat, location_lng, map_pin_icon, is_featured, published_at, created_at, updated_at)
VALUES
  -- Ticketed on WaahTickets, featured, two listings share Purple Haze.
  ('lst_rocknight', 'kathmandu-rock-night', 'Kathmandu Rock Night',
   'Three bands, one stage, Thamel''s loudest night of the month.',
   'A monthly showcase of Kathmandu''s rock scene, running since 2016.',
   'ticketed_internal', 'organizer', 'published', 'org_himalayan', 'ven_purple',
   strftime('%Y-%m-%dT19:00:00Z', 'now', '+5 days'), strftime('%Y-%m-%dT23:30:00Z', 'now', '+5 days'), 0, NULL,
   NULL, 'https://waahtickets.example/e/kathmandu-rock-night', 'waahtickets', 80000, 0,
   NULL, NULL, 'Concert', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  ('lst_acoustic', 'acoustic-sundays-thamel', 'Acoustic Sundays',
   'Unplugged sets every Sunday evening.', NULL,
   'free', 'organizer', 'published', 'org_himalayan', 'ven_purple',
   strftime('%Y-%m-%dT17:30:00Z', 'now', '+2 days'), NULL, 0, NULL,
   NULL, NULL, NULL, NULL, 0,
   NULL, NULL, 'Concert', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Sold elsewhere: NepScene links out and computes nothing.
  ('lst_bipul', 'bipul-chettri-live-pokhara', 'Bipul Chettri Live in Pokhara',
   'The Lakeside show, outdoors by the lake.', NULL,
   'ticketed_external', 'organizer', 'published', 'org_lakeside', 'ven_lakeside',
   strftime('%Y-%m-%dT18:00:00Z', 'now', '+12 days'), NULL, 0, NULL,
   'https://example.np/bipul-pokhara', 'https://example.np/bipul-pokhara/tickets', 'external', 150000, 0,
   NULL, NULL, 'Concert', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Free, community-run, no organization at all — the listing WaahTickets could not represent.
  ('lst_cleanup', 'phewa-lake-cleanup', 'Phewa Lake Clean-up',
   'Volunteer morning along the lake shore. Gloves provided.', NULL,
   'free', 'submission', 'published', NULL, 'ven_lakeside',
   strftime('%Y-%m-%dT01:15:00Z', 'now', '+3 days'), strftime('%Y-%m-%dT06:00:00Z', 'now', '+3 days'), 0, NULL,
   NULL, NULL, NULL, NULL, 0,
   28.2130, 83.9490, 'Community', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Multi-day festival, all-day, editorial provenance.
  ('lst_indrajatra', 'indra-jatra-basantapur', 'Indra Jatra',
   'Eight days of masked dance, chariot processions and Kumari darshan.', NULL,
   'free', 'editorial', 'published', 'org_nepscene', 'ven_patan',
   strftime('%Y-%m-%dT00:00:00Z', 'now', '+20 days'), strftime('%Y-%m-%dT23:59:00Z', 'now', '+27 days'), 1, NULL,
   NULL, NULL, NULL, NULL, 0,
   NULL, NULL, 'Festival', 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  ('lst_football', 'nepal-vs-bhutan-friendly', 'Nepal vs Bhutan — International Friendly',
   'Kick-off at Dashrath Rangasala.', NULL,
   'ticketed_internal', 'organizer', 'published', 'org_himalayan', 'ven_dashrath',
   strftime('%Y-%m-%dT10:00:00Z', 'now', '+9 days'), NULL, 0, NULL,
   NULL, 'https://waahtickets.example/e/nepal-bhutan', 'waahtickets', 30000, 1,
   NULL, NULL, 'Sports', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  ('lst_comedy', 'standup-night-lalitpur', 'Stand-up Night Lalitpur',
   'Six comics, English and Nepali sets.', NULL,
   'ticketed_external', 'organizer', 'published', 'org_lakeside', 'ven_patan',
   strftime('%Y-%m-%dT13:30:00Z', 'now', '+6 days'), NULL, 0, NULL,
   'https://example.np/standup', 'https://example.np/standup/book', 'external', 50000, 0,
   NULL, NULL, 'Comedy', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  ('lst_foodfest', 'newari-food-festival', 'Newari Food Festival',
   'Yomari, chatamari and bara across twenty stalls.', NULL,
   'free', 'import', 'published', NULL, 'ven_bhaktapur',
   strftime('%Y-%m-%dT05:00:00Z', 'now', '+15 days'), strftime('%Y-%m-%dT14:00:00Z', 'now', '+16 days'), 0, NULL,
   'https://example.np/newari-food', NULL, NULL, NULL, 0,
   NULL, NULL, 'Food & Drink', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  ('lst_birding', 'chitwan-birding-walk', 'Chitwan Birding Walk',
   'Early morning walk along the Rapti with a park guide.', NULL,
   'ticketed_external', 'submission', 'published', NULL, 'ven_sauraha',
   strftime('%Y-%m-%dT00:30:00Z', 'now', '+30 days'), NULL, 0, NULL,
   NULL, 'https://example.np/birding', 'external', 120000, 0,
   NULL, NULL, 'Community', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- No venue: an announcement is not an attendance model.
  ('lst_reopen', 'patan-museum-reopens', 'Patan Museum Reopens',
   'The museum reopens after eight months of restoration work.', NULL,
   'announcement', 'editorial', 'published', 'org_nepscene', NULL,
   strftime('%Y-%m-%dT04:00:00Z', 'now', '+40 days'), NULL, 1, NULL,
   NULL, NULL, NULL, NULL, 0,
   NULL, NULL, NULL, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Finished last week: must not appear unless include_past=true.
  ('lst_past', 'jazzmandu-closing-night', 'Jazzmandu Closing Night',
   'The festival''s final night.', NULL,
   'ticketed_internal', 'organizer', 'published', 'org_himalayan', 'ven_purple',
   strftime('%Y-%m-%dT13:00:00Z', 'now', '-8 days'), strftime('%Y-%m-%dT18:00:00Z', 'now', '-8 days'), 0, NULL,
   NULL, NULL, NULL, NULL, 0,
   NULL, NULL, 'Concert', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-40 days'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Running right now: started yesterday, ends tomorrow. Still "upcoming".
  ('lst_running', 'kathmandu-art-week', 'Kathmandu Art Week',
   'Galleries across the valley open late all week.', NULL,
   'free', 'editorial', 'published', 'org_nepscene', 'ven_patan',
   strftime('%Y-%m-%dT03:00:00Z', 'now', '-1 days'), strftime('%Y-%m-%dT12:00:00Z', 'now', '+1 days'), 0, NULL,
   NULL, NULL, NULL, NULL, 0,
   NULL, NULL, 'Arts & Theatre', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-10 days'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  -- Neither of these is published, and neither may ever appear in a public read.
  ('lst_draft', 'unfinished-draft-listing', 'Draft — do not publish',
   NULL, NULL, 'free', 'organizer', 'draft', 'org_himalayan', 'ven_purple',
   strftime('%Y-%m-%dT12:00:00Z', 'now', '+7 days'), NULL, 0, NULL,
   NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),

  ('lst_pending', 'submitted-awaiting-review', 'Submitted — awaiting review',
   'A public submission in the moderation queue.', NULL,
   'free', 'submission', 'pending_review', NULL, 'ven_lakeside',
   strftime('%Y-%m-%dT12:00:00Z', 'now', '+8 days'), NULL, 0, NULL,
   NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, 0, NULL, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));

INSERT INTO listing_categories (listing_id, category_id, is_primary) VALUES
  ('lst_rocknight',  'cat_concert',   1),
  ('lst_rocknight',  'cat_nightlife', 0),
  ('lst_acoustic',   'cat_concert',   1),
  ('lst_bipul',      'cat_concert',   1),
  ('lst_cleanup',    'cat_community', 1),
  ('lst_indrajatra', 'cat_festival',  1),
  ('lst_indrajatra', 'cat_religious', 0),
  ('lst_football',   'cat_sports',    1),
  ('lst_comedy',     'cat_comedy',    1),
  ('lst_foodfest',   'cat_food',      1),
  ('lst_foodfest',   'cat_market',    0),
  ('lst_birding',    'cat_community', 1),
  ('lst_running',    'cat_arts',      1),
  ('lst_past',       'cat_concert',   1),
  ('lst_draft',      'cat_concert',   1);

INSERT INTO listing_artists (listing_id, artist_id, billing_order) VALUES
  ('lst_rocknight', 'art_1974ad',  0),
  ('lst_rocknight', 'art_kutumba', 1),
  ('lst_bipul',     'art_bipul',   0);

-- An old URL that must keep working (#24).
INSERT INTO slug_redirects (entity_type, old_slug, entity_id, created_at) VALUES
  ('listing', 'ktm-rock-night-2026', 'lst_rocknight', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
