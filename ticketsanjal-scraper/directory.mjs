// Return the ready snapshot from the same browser evaluation that checks it.
// During pagination the old cards may disappear before the new ones arrive.
export async function readDirectoryCards(page, previous = '') {
 const handle = await page.waitForFunction(previous => {
  const links = [...document.querySelectorAll('a[href^="/events/"]')]
   .filter(a => /^\/events\/\d+$/.test(a.getAttribute('href')))
  if (!links.length || links.map(a => a.href).join('|') === previous) return false
  return links.map(a => ({
   url: a.href,
   title: a.querySelector('h1,h2,h3')?.textContent?.trim(),
   card_text: a.innerText,
   image_url: a.querySelector('img')?.src,
   booking_disabled: a.querySelector('button')?.disabled ?? null,
  }))
 }, previous, {timeout: 30000})
 try { return await handle.jsonValue() }
 finally { await handle.dispose() }
}
export function waitForDirectoryResponse(page, pageNumber) {
 return page.waitForResponse(response => {
  const url = new URL(response.url())
  return url.pathname === '/api/v1/event/search' && Number(url.searchParams.get('page')) === pageNumber
 }, {timeout: 30000})
}

export function withArchiveStatus(cards, payload) {
 if (payload.success !== true || !Array.isArray(payload.data?.data)) throw Error('Invalid directory API response')
 const events = new Map(payload.data.data.map(event => [String(event.id), event]))
 return cards.map(card => {
  const event = events.get(new URL(card.url).pathname.split('/').at(-1))
  if (typeof event?.isExpired !== 'boolean') throw Error(`Missing archive status: ${card.url}`)
  return {...card, is_expired: event.isExpired}
 })
}
