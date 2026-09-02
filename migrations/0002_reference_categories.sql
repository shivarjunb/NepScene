-- 0002 — Category reference data (#22)
--
-- Reference data, not demo data: the six colours and icons for Concert,
-- Food & Drink, Festival, Sports, Comedy and Nightlife are lifted verbatim from
-- WaahTickets' CATEGORY_CONFIG (NepalMap.tsx) so the ported map pins keep the
-- exact palette people already recognise. The six after them are NepScene's
-- widening of scope — the events nobody sells.
--
-- Nepali labels are a first pass and need a native review before #46 ships.

INSERT INTO categories (id, slug, name, name_ne, icon, color, sort_order, is_active) VALUES
  ('cat_concert',   'concerts',       'Concerts',        'कन्सर्ट',        'Music',          '#e91e63',  10, 1),
  ('cat_festival',  'festivals',      'Festivals',       'चाडपर्व',        'Star',           '#9c27b0',  20, 1),
  ('cat_sports',    'sports',         'Sports',          'खेलकुद',         'Trophy',         '#22c55e',  30, 1),
  ('cat_comedy',    'comedy',         'Comedy',          'हास्य',          'Laugh',          '#3b82f6',  40, 1),
  ('cat_food',      'food-and-drink', 'Food & Drink',    'खानपान',         'Utensils',       '#ff9800',  50, 1),
  ('cat_nightlife', 'nightlife',      'Nightlife',       'नाइटलाइफ',       'Moon',           '#06b6d4',  60, 1),
  ('cat_arts',      'arts-theatre',   'Arts & Theatre',  'कला र नाटक',     'Drama',          '#8b5cf6',  70, 1),
  ('cat_community', 'community',      'Community',       'सामुदायिक',      'Users',          '#14b8a6',  80, 1),
  ('cat_workshop',  'workshops',      'Workshops',       'कार्यशाला',      'GraduationCap',  '#f59e0b',  90, 1),
  ('cat_film',      'film',           'Film',            'चलचित्र',        'Film',           '#ef4444', 100, 1),
  ('cat_market',    'markets',        'Markets',         'बजार',           'ShoppingBag',    '#84cc16', 110, 1),
  ('cat_religious', 'religious',      'Religious',       'धार्मिक',        'Landmark',       '#eab308', 120, 1);
