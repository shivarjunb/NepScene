import { createHash } from 'node:crypto'
import { decode, transform as baseTransform } from './katajaam.mjs'
export { plan, buildSql } from './katajaam.mjs'
export const ORIGIN = 'https://taragaonnext.com'
const hash = s => createHash('sha256').update(s).digest('hex').slice(0,24)
const text = s => decode(s.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim()
const attr = (s,k) => decode(s.match(new RegExp('\\b'+k+'=["\x27]([^"\x27]*)["\x27]','i'))?.[1] ?? '')
function field(html, cls) {
  return html.match(new RegExp('<[^>]+class=["\x27][^"\x27]*\\b'+cls+'\\b[^"\x27]*["\x27][^>]*>([\\s\\S]*?)</(?:p|h4)>','i'))?.[1] ?? ''
}
export function startTime(value) {
  const m = value.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})(?:\s*-\s*[A-Za-z]+\s+\d{1,2},\s*\d{4})?\s*\|\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s+onwards)?$/i)
  if (!m) return null
  const month = 'january february march april may june july august september october november december'.split(' ').indexOf(m[1].toLowerCase())
  const day=+m[2], year=+m[3], hour=+m[4], minute=+(m[5]??0)
  if(month<0 || hour<1 || hour>12 || minute>59 || day<1 || day>new Date(Date.UTC(year,month+1,0)).getUTCDate()) return null
  return `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}T${String(hour%12+(m[6].toLowerCase()==='p'?12:0)).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+05:45`
}
export function listingPage(html) {
  const events = new Map()
  for (const block of html.split(/<div\b[^>]*class=["'][^"']*\bevent-item\b[^"']*["'][^>]*>/i).slice(1)) {
    const tag=block.match(/<a\b[^>]*class=["'][^"']*\bevent-link\b[^"']*["'][^>]*>/i)?.[0]
    if(!tag) throw Error('Event card lacks detail link; site format may have changed')
    const u=new URL(attr(tag,'href'),ORIGIN)
    if(u.origin!==ORIGIN || !/^\/events\/[^/]+\/$/.test(u.pathname)) throw Error('Unexpected event URL')
    u.search='';u.hash=''
    const e={url:u.href,name:text(field(block,'event-title')),date_text:text(field(block,'event-date')),image:attr(block.match(/<img\b[^>]*>/i)?.[0]??'','src')}
    if(!e.name) throw Error('Event card lacks title')
    if(events.has(e.url) && JSON.stringify(events.get(e.url))!==JSON.stringify(e)) throw Error('Conflicting duplicate event cards: '+e.url)
    events.set(e.url,e)
  }
  if(!events.size) throw Error('No event cards found; refusing empty scrape')
  return [...events.values()]
}
export function eventPage(html, card) {
  const content=html.match(/<div\b[^>]*class=["'][^"']*\belementor-widget-theme-post-content\b[^"']*["'][^>]*>\s*<div[^>]*>([\s\S]*?)<\/div>/i)?.[1]
  if(!content) throw Error('Missing event description: '+card.url)
  const value = cls => text(html.match(new RegExp('class=["\x27][^"\x27]*\\b'+cls+'\\b[^"\x27]*["\x27][^>]*>[\\s\\S]*?<p[^>]*>([\\s\\S]*?)</p>','i'))?.[1]??'')
  const date_text=text(field(html,'event-date'))
  const description=text(content)
  let venue=value('venue_value')
  if(!venue) venue=description.match(/Starting Point:\s*(.*?)(?=\s+Lwohshala|\s+This program|$)/i)?.[1]??''
  if(!venue && /grounds of Taragaon|Taragaon is your canvas/i.test(description)) venue='Taragaon Next'
  const ticketBlock=html.match(/class=["'][^"']*\btickets_value\b[^"']*["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i)?.[1]??''
  const ticketTag=ticketBlock.match(/<a\b[^>]*>/i)?.[0]??''
  let ticket=attr(ticketTag,'href')
  if(!/^https?:\/\//i.test(ticket)) ticket=text(ticketBlock).match(/^https?:\/\/\S+$/i)?.[0]??null
  return {...card,date_text,startDate:startTime(date_text),description,
    location:{name:venue,address:{addressLocality:venue?'Kathmandu':''}},organizer:{name:value('organizer_value')},
    category:/film|screening/i.test(card.name)?'Screenings & Watch Parties':/workshop|reading circle/i.test(card.name)?'Learning & Workshops':/walk/i.test(card.name)?'Outdoors & Hikes':'Art & Exhibitions',
    isAccessibleForFree:/\bFree Entry\b/i.test(text(ticketBlock)),offers:{url:ticket},
  }
}
export async function crawl(read) {
  const cards=listingPage(await read(ORIGIN+'/whats-on/')), events=[]
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kathmandu'})
  for(const card of cards) {
    // Old dated cards need no detail request. Undated cards are excluded explicitly.
    const start=startTime(card.date_text)
    if(!start) { events.push({...card,skip:'Missing or unsupported explicit start date/time'}); continue }
    if(start.slice(0,10)<today && !card.date_text.includes(' - ')) { events.push({...card,skip:'Past event'}); continue }
    events.push(eventPage(await read(card.url),card))
  }
  return {source:ORIGIN,checked_at:new Date().toISOString(),count:events.length,events}
}
export function transform(raw, overrides={},publish=false,now=new Date().toISOString()) {
  if(raw.skip) return {...raw,skip:raw.skip}
  const start=startTime(raw.date_text??'')
  if(!start) return {...raw,skip:'Missing or unsupported explicit start date/time'}
  if(Date.parse(start)<Date.parse(now)) return {...raw,skip:'Start is in the past'}
  const url=new URL(raw.url)
  if(url.origin!==ORIGIN || !/^\/events\/[^/]+\/$/.test(url.pathname)) throw Error('Invalid Taragaon source URL')
  const key='taragaon:'+url.pathname.split('/')[2]
  const venueName=text(raw.location?.name??'')
  const unannounced=!venueName || /venue.*(?:announced|tba)|^(?:tba|tbd|unannounced|to be announced|to be decided)$/i.test(venueName)
  // Apply the source-specific default here so saved inventories use it too.
  // Reviewed overrides still take precedence in baseTransform.
  const location=unannounced ? {name:'Taragaon Next',address:{addressLocality:'Boudha'}} : raw.location
  const e=baseTransform({...raw,location,url:'https://katajaam.com/events/'+hash(key),startDate:start}, {...overrides,starts_at:start,confirm_midnight:true},publish,now)
  if(e.skip) return {...e,url:raw.url}
  e.description=e.description.replace(/Source: https:\/\/katajaam.com\/events\/[^\s]+/,'Source: '+raw.url)
  return {...e,id:'tg_'+hash(key),source_id:key,fingerprint:'taragaon:'+hash(e.fingerprint),url:raw.url}
}
