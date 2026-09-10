/**
 * Every string the public site says, in both languages (#46).
 *
 * **One table, not two files.** A pair of per-language dictionaries drifts the
 * moment somebody adds an English string in a hurry, and the drift is silent —
 * the interface just falls back to the key, in production, in the language
 * that was the point of the feature. Holding both spellings on one line makes
 * a missing translation a type error, and `tests/unit/i18n.test.ts` fails on
 * an empty one.
 *
 * **Scope, stated rather than discovered.** This covers the public site: the
 * shell, discovery, search, listings, venues, organizers and artists. The
 * authoring wizard and the moderation queue are not translated — they are
 * tools for people who chose to list events here, not the audience #46 exists
 * for, and translating four hundred form strings would have crowded out the
 * pages a Nepali reader actually lands on. It is remaining scope on #46, not
 * an oversight.
 *
 * A note on tone: Nepali interface Nepali is not literary Nepali. These are
 * the spellings people see on Nepali sites they already use, and they still
 * want a native speaker's pass for tone rather than accuracy (#46's test plan
 * says exactly that, and it is the one check a test cannot do).
 */
export const STRINGS = {
  // ── Shell ────────────────────────────────────────────────────────────────
  'nav.discover': { en: 'Discover', ne: 'खोज्नुहोस्' },
  'nav.map': { en: 'Map', ne: 'नक्सा' },
  'nav.venues': { en: 'Venues', ne: 'स्थलहरू' },
  'nav.organizers': { en: 'Organizers', ne: 'आयोजकहरू' },
  'nav.search': { en: 'Search', ne: 'खोज' },
  'nav.home': { en: 'NepScene home', ne: 'नेपसिन गृहपृष्ठ' },
  'nav.menu.open': { en: 'Open menu', ne: 'मेनु खोल्नुहोस्' },
  'nav.menu.close': { en: 'Close menu', ne: 'मेनु बन्द गर्नुहोस्' },
  'nav.close': { en: 'Close', ne: 'बन्द गर्नुहोस्' },
  'nav.primary': { en: 'Primary', ne: 'मुख्य' },
  'nav.skip': { en: 'Skip to content', ne: 'सामग्रीमा जानुहोस्' },
  'footer.tagline': { en: 'What’s happening around Nepal.', ne: 'नेपालभरि के-के भइरहेको छ।' },
  'footer.about': { en: 'About', ne: 'हाम्रो बारेमा' },
  'footer.submit': { en: 'Submit an event', ne: 'कार्यक्रम पठाउनुहोस्' },
  'footer.dashboard': { en: 'Your listings', ne: 'तपाईंका सूचीहरू' },
  'footer.privacy': { en: 'Privacy', ne: 'गोपनीयता' },
  'footer.designSystem': { en: 'Design system', ne: 'डिजाइन प्रणाली' },
  'footer.label': { en: 'Footer', ne: 'फुटर' },
  'language.label': { en: 'Language', ne: 'भाषा' },
  'language.english': { en: 'English', ne: 'English' },
  'language.nepali': { en: 'नेपाली', ne: 'नेपाली' },

  // ── Discovery ────────────────────────────────────────────────────────────
  'discover.title': { en: 'What’s happening around Nepal', ne: 'नेपालभरि के-के भइरहेको छ' },
  'discover.lead': {
    en: 'Concerts, festivals, sport, comedy and community events — bounded and upcoming by default.',
    ne: 'कन्सर्ट, चाडपर्व, खेलकुद, हास्य र सामुदायिक कार्यक्रम — आउँदै गरेका मात्र।',
  },
  'discover.everything': { en: 'Everything', ne: 'सबै' },
  /**
   * The dynamic hero headline (#38). It names the detected city, so it is one
   * string with a slot rather than a sentence assembled from fragments —
   * Nepali puts the postposition on the place name (`काठमाडौं वरिपरि`), and a
   * concatenation would put it in the wrong half.
   */
  'discover.titleIn': { en: 'What’s happening around {city}', ne: '{city} वरिपरि के-के भइरहेको छ' },
  'map.nearMe': { en: 'Near me', ne: 'मेरो नजिक' },
  'map.locating': { en: 'Finding you…', ne: 'खोज्दै…' },
  'map.centred': { en: 'Centred on you', ne: 'तपाईंमा केन्द्रित' },
  'map.showList': { en: 'List', ne: 'सूची' },
  'map.showMap': { en: 'Map', ne: 'नक्सा' },
  'map.distanceGroup': { en: 'Filter by distance', ne: 'दूरीअनुसार छान्नुहोस्' },
  'map.km': { en: '{km} km', ne: '{km} किमी' },
  'map.denied': {
    en: 'Location is off, so this is {city}. Turn it on in your browser to sort by how far away things are.',
    ne: 'स्थान बन्द छ, त्यसैले यो {city} हो। दूरीअनुसार छान्न ब्राउजरमा स्थान खोल्नुहोस्।',
  },
  'discover.browseByCategory': { en: 'Browse by category', ne: 'वर्गअनुसार हेर्नुहोस्' },
  'discover.results': { en: 'Results', ne: 'नतिजा' },
  // The locative is a suffix, written closed up — not a separate word the way
  // "in" is. This is the case the placeholder substitution exists for.
  'discover.inCity': { en: 'In {city}', ne: '{city}मा' },
  'discover.nothingYet': { en: 'Nothing on yet', ne: 'अहिलेसम्म केही छैन' },
  'discover.nothingYetBody': {
    en: 'The catalogue has no upcoming listings. Rows appear here as soon as something is published.',
    ne: 'सूचीमा आउँदै गरेको कुनै कार्यक्रम छैन। केही प्रकाशित हुनासाथ यहाँ देखिनेछ।',
  },
  'discover.nothingHere': { en: 'Nothing coming up here yet.', ne: 'यहाँ अहिलेलाई केही छैन।' },
  'discover.seeEverything': { en: 'See everything', ne: 'सबै हेर्नुहोस्' },
  'discover.loadFailed': { en: 'The catalogue did not load', ne: 'सूची लोड भएन' },
  'discover.tryAgain': { en: 'try again', ne: 'फेरि प्रयास गर्नुहोस्' },
  'discover.seeAll': { en: 'See all', ne: 'सबै हेर्नुहोस्' },

  // ── Search ───────────────────────────────────────────────────────────────
  'search.title': { en: 'Search', ne: 'खोज' },
  'search.placeholder': { en: 'Search events, venues, places', ne: 'कार्यक्रम, स्थल, ठाउँ खोज्नुहोस्' },
  'search.submit': { en: 'Search', ne: 'खोज्नुहोस्' },
  'search.clear': { en: 'Clear search', ne: 'खोज हटाउनुहोस्' },
  'search.suggestions': { en: 'Suggestions', ne: 'सुझावहरू' },
  'search.resultsFor': { en: 'Results for “{query}”', ne: '“{query}” का नतिजा' },
  'search.everything': { en: 'Everything on', ne: 'सबै कार्यक्रम' },
  'search.correctedFrom': {
    en: 'Showing results for a corrected spelling of “{query}”.',
    ne: '“{query}” को सच्चिएको हिज्जेका नतिजा देखाइँदै छ।',
  },
  'search.searchInstead': { en: 'Search for “{query}” instead', ne: 'बरु “{query}” खोज्नुहोस्' },
  'search.noResults': { en: 'Nothing matched “{query}”', ne: '“{query}” सँग केही मिलेन' },
  'search.noResultsBody': {
    en: 'Try one of these, or clear the filters.',
    ne: 'यीमध्ये कुनै प्रयास गर्नुहोस्, वा फिल्टर हटाउनुहोस्।',
  },
  'search.filters': { en: 'Filters', ne: 'फिल्टर' },
  'search.clearFilters': { en: 'Clear filters', ne: 'फिल्टर हटाउनुहोस्' },
  'search.facet.city': { en: 'City', ne: 'सहर' },
  'search.facet.category': { en: 'Category', ne: 'वर्ग' },
  'search.facet.price': { en: 'Entry', ne: 'प्रवेश' },
  'search.facet.when': { en: 'When', ne: 'कहिले' },
  'search.nearMe': { en: 'Near me', ne: 'मेरो नजिक' },
  'search.locating': { en: 'Finding you…', ne: 'तपाईंलाई खोज्दै…' },
  'search.locationRefused': {
    en: 'Your browser did not share a location.',
    ne: 'तपाईंको ब्राउजरले स्थान दिएन।',
  },
  'search.more': { en: 'Show more results', ne: 'थप नतिजा देखाउनुहोस्' },
  'search.counted': { en: '{count} listings', ne: '{count} सूची' },

  // ── Listing page ─────────────────────────────────────────────────────────
  'listing.when': { en: 'When', ne: 'कहिले' },
  'listing.where': { en: 'Where', ne: 'कहाँ' },
  'listing.about': { en: 'About this event', ne: 'यस कार्यक्रमबारे' },
  'listing.lineup': { en: 'Line-up', ne: 'कलाकार' },
  'listing.organizer': { en: 'Organized by', ne: 'आयोजक' },
  'listing.verified': { en: 'Verified', ne: 'प्रमाणित' },
  'listing.tickets': { en: 'Tickets', ne: 'टिकट' },
  'listing.getTickets': { en: 'Get tickets', ne: 'टिकट लिनुहोस्' },
  'listing.priceFrom': { en: 'From {price}', ne: '{price} देखि' },
  'listing.soldOut': { en: 'Sold out', ne: 'टिकट सकियो' },
  'listing.free': { en: 'Free entry', ne: 'निःशुल्क प्रवेश' },
  'listing.visitSite': { en: 'Visit the event site', ne: 'कार्यक्रमको साइट हेर्नुहोस्' },
  'listing.offerUnavailable': {
    en: 'Ticket details are not available right now.',
    ne: 'टिकटको विवरण अहिले उपलब्ध छैन।',
  },
  'listing.priceChecked': { en: 'Price checked {when}', ne: 'मूल्य {when} जाँचिएको' },
  'listing.addToCalendar': { en: 'Add to calendar', ne: 'क्यालेन्डरमा राख्नुहोस्' },
  'listing.share': { en: 'Share', ne: 'सेयर गर्नुहोस्' },
  'listing.shareWhatsApp': { en: 'Share on WhatsApp', ne: 'ह्वाट्सएपमा सेयर गर्नुहोस्' },
  'listing.shareFacebook': { en: 'Share on Facebook', ne: 'फेसबुकमा सेयर गर्नुहोस्' },
  'listing.shareX': { en: 'Share on X', ne: 'X मा सेयर गर्नुहोस्' },
  'listing.copyLink': { en: 'Copy link', ne: 'लिङ्क कपी गर्नुहोस्' },
  'listing.linkCopied': { en: 'Link copied', ne: 'लिङ्क कपी भयो' },
  'listing.directions': { en: 'Directions', ne: 'बाटो हेर्नुहोस्' },
  'listing.related': { en: 'You might also like', ne: 'यो पनि हेर्नुहोस्' },
  'listing.notFound': { en: 'No such listing', ne: 'यस्तो सूची छैन' },
  'listing.notFoundBody': {
    en: 'It may have been taken down, or the link may be wrong.',
    ne: 'यो हटाइएको हुन सक्छ, वा लिङ्क गलत हुन सक्छ।',
  },
  'listing.allDay': { en: 'All day', ne: 'दिनभरि' },
  'listing.until': { en: 'until {end}', ne: '{end} सम्म' },
  'listing.announcement': { en: 'Announcement', ne: 'सूचना' },
  'listing.externalTickets': { en: 'Tickets elsewhere', ne: 'टिकट अन्यत्र' },
  'listing.gallery': { en: 'Pictures', ne: 'तस्बिरहरू' },

  // ── Venues, organizers, artists ──────────────────────────────────────────
  'venues.title': { en: 'Venues', ne: 'स्थलहरू' },
  'venues.lead': {
    en: 'Places that host things, and what is coming up at each.',
    ne: 'कार्यक्रम हुने ठाउँहरू, र प्रत्येकमा के आउँदैछ।',
  },
  'venues.searchPlaceholder': { en: 'Find a venue', ne: 'स्थल खोज्नुहोस्' },
  'organizers.title': { en: 'Organizers', ne: 'आयोजकहरू' },
  'organizers.lead': {
    en: 'Who puts events on, and everything they have listed.',
    ne: 'कार्यक्रम गर्नेहरू, र तिनका सबै सूची।',
  },
  'organizers.searchPlaceholder': { en: 'Find an organizer', ne: 'आयोजक खोज्नुहोस्' },
  'place.upcoming': { en: 'What’s on', ne: 'के-के छ' },
  'place.past': { en: 'Previously here', ne: 'यसअघि भएका' },
  'place.pastElsewhere': { en: 'Previously', ne: 'यसअघि' },
  'place.nothingUpcoming': {
    en: 'Nothing coming up right now.',
    ne: 'अहिले आउँदै गरेको केही छैन।',
  },
  'place.nothingAtAll': {
    en: 'Nothing has been listed here yet.',
    ne: 'यहाँ अहिलेसम्म केही सूचीबद्ध भएको छैन।',
  },
  'place.capacity': { en: 'Holds about {count}', ne: 'करिब {count} जना अट्ने' },
  'place.website': { en: 'Website', ne: 'वेबसाइट' },
  'place.phone': { en: 'Phone', ne: 'फोन' },
  'place.follow': { en: 'Follow', ne: 'फलो गर्नुहोस्' },
  'place.followSoon': {
    en: 'Following arrives after launch.',
    ne: 'फलो गर्ने सुविधा सुरुआतपछि आउनेछ।',
  },
  'place.count.upcoming': { en: '{count} coming up', ne: '{count} आउँदै' },
  'place.count.past': { en: '{count} before', ne: '{count} यसअघि' },
  'artist.title': { en: 'Artist', ne: 'कलाकार' },
  'artist.notFound': {
    en: 'No page for that artist',
    ne: 'त्यो कलाकारको पृष्ठ छैन',
  },
  'artist.notFoundBody': {
    en: 'An artist gets a page once they are on more than one listing.',
    ne: 'एकभन्दा बढी कार्यक्रममा भएपछि कलाकारको पृष्ठ बन्छ।',
  },

  // ── Shared ───────────────────────────────────────────────────────────────
  'common.loading': { en: 'Loading', ne: 'लोड हुँदै' },
  'common.error': { en: 'Something went wrong', ne: 'केही गडबड भयो' },
  'common.retry': { en: 'Try again', ne: 'फेरि प्रयास गर्नुहोस्' },
  'common.backHome': { en: 'Back to the homepage', ne: 'गृहपृष्ठमा फर्कनुहोस्' },
  'common.showMore': { en: 'Show more', ne: 'थप देखाउनुहोस्' },
} as const

export type StringKey = keyof typeof STRINGS
export type Language = 'en' | 'ne'
