import { createHash } from 'node:crypto'
import { parseFragment } from 'parse5'
import { decode, transform as baseTransform } from './katajaam.mjs'
export { plan, buildSql } from './katajaam.mjs'
const hash = s => createHash('sha256').update(s).digest('hex').slice(0,24)
// Extract plain text from parsed nodes; this is not an HTML sanitiser.
export function text(value) {
 const parts=[]
 function walk(node) {
  if(['script','style','template'].includes(node.tagName))return
  if(node.nodeName==='#text')parts.push(node.value)
  for(const child of node.childNodes??[])walk(child)
 }
 walk(parseFragment(String(value??'')))
 return parts.join(' ').replace(/\s+/g,' ').trim()
}
function scripts(html) {
 const out=[]
 function walk(node) {
  if(node.tagName==='script')out.push({attrs:Object.fromEntries(node.attrs.map(a=>[a.name,a.value])),body:node.childNodes.map(n=>n.value??'').join('')})
  for(const child of node.childNodes??[])walk(child)
 }
 walk(parseFragment(html))
 return out
}
export const attrs = s => Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),decode(m[2]??m[3])]))
export function publicUrl(value, base) {
 try { const u=new URL(value,base); if(!/^https?:$/.test(u.protocol)||u.username||u.password)return null;u.hash='';return u.href } catch { return null }
}
export function objects(value) {
 const out=[],seen=new Set()
 function walk(v) { if(!v || typeof v!=='object'||seen.has(v))return;seen.add(v);if(!Array.isArray(v))out.push(v);for(const x of Object.values(v))walk(x) }
 walk(value);return out
}
export function structuredEvents(html,url) {
 const events=[],errors=[]
 for(const script of scripts(html)) {
  if(script.attrs.type!=='application/ld+json')continue
  try { for(const e of objects(JSON.parse(script.body))) {
   if(![e['@type']].flat().some(t=>typeof t==='string' && /(?:^|\/)(?:Event|[A-Za-z]+Event|Festival)$/.test(t)))continue
   if(!e.name || !e.startDate)continue
   events.push({...e,url:publicUrl(e.url??e['@id'],url)??url,source_page:url})
  }} catch(error) { errors.push(`Invalid JSON-LD at ${url}: ${error.message}`) }
 }
 return {events,errors}
}
// Nuxt/devalue payloads reference a shared array. Decode data, never execute scripts.
export function nuxtData(html) {
 const script=scripts(html).find(s=>s.attrs.id==='__NUXT_DATA__')
 if(!script)return null
 const pool=JSON.parse(script.body),memo=new Map()
 function get(i) {
  if(i===-1)return undefined
  if(i<0)return null
  if(memo.has(i))return memo.get(i)
  const v=pool[i];if(!v || typeof v!=='object')return v
  if(Array.isArray(v)&&['Reactive','ShallowReactive','Ref','ShallowRef'].includes(v[0]))return get(v[1])
  const out=Array.isArray(v)?[]:{};memo.set(i,out)
  for(const [k,x]of Object.entries(v))out[k]=typeof x==='number'?get(x):x
  return out
 }
 return get(0)
}
export function explicitDate(value) {
 if(typeof value!=='string')return null
 const m=value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/)
 if(!m)return null
 const y=+m[1],mo=+m[2],d=+m[3]
 if(y<1900||mo<1||mo>12||d<1||d>new Date(Date.UTC(y,mo,0)).getUTCDate())return null
 if(m[4] && (+m[4]>23||+m[5]>59||+(m[6]??0)>59||!Number.isFinite(Date.parse(value))))return null
 return value
}
export function dateRange(value) {
 let s=text(value).replace(/[–—]/g,'-').replace(/\bto\b/gi,'-').replace(/,/g,'').trim()
 s=s.replace(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s+([A-Za-z]+)\s+(\d{4})$/,(_,d,e,m,y)=>`${m} ${d}${e?' - '+e:''} ${y}`)
 const m=s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*-\s*(?:([A-Za-z]+)\s+)?(\d{1,2}))?\s+(\d{4})$/)
 if(!m)return null
 const month=name=>'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(name.toLowerCase().slice(0,3))+1
 const start=`${m[5]}-${String(month(m[1])).padStart(2,'0')}-${m[2].padStart(2,'0')}`
 const end=m[4]?`${m[5]}-${String(month(m[3]??m[1])).padStart(2,'0')}-${m[4].padStart(2,'0')}`:undefined
 if(!explicitDate(start)||end&&(!explicitDate(end)||end<start))return null
 return {startDate:start,endDate:end}
}
export function tribeEvents(data,url) {
 if(!Array.isArray(data.events)||!Number.isInteger(data.total_pages))throw Error('Unrecognized Events Calendar response')
 return data.events.map(e=>({name:text(e.title),url:publicUrl(e.url,url),source_page:url,source_key:String(e.id),description:text(e.description),
  startDate:e.all_day?e.start_date?.slice(0,10):e.utc_start_date?.replace(' ','T')+'Z',endDate:e.all_day?e.end_date?.slice(0,10):e.utc_end_date?.replace(' ','T')+'Z',
  location:{name:e.venue?.venue,address:{streetAddress:e.venue?.address,addressLocality:e.venue?.city,addressCountry:e.venue?.country}},
  organizer:(e.organizer??[]).map(o=>({name:o.organizer,url:o.url})),image:e.image?.url,
  offers:{url:e.website},date_text:e.all_day?`${e.start_date} – ${e.end_date} (all day)`:undefined}))
}
export function customEvents(html,url,adapter) {
 const events=[],clean=text(html)
 if(adapter==='ieff') {
  const block=html.match(/Countdown to IEFF-NEPAL[\s\S]*?<div class="action-content">([\s\S]*?)<\/div>/i)?.[1]??''
  if(/KATHMANDU/i.test(text(block)))for(const m of text(block).matchAll(/([A-Z]+\s+\d{1,2}-\d{1,2},\s+\d{4})/g)) {
   const dates=dateRange(m[1]);if(dates)events.push({name:'International Ethnic Folklore Festival Nepal',url,source_page:url,source_key:dates.startDate,...dates,location:{name:'Kathmandu; specific venue to confirm'}})
  }
 } else if(adapter==='royalmt') {
  for(const part of html.split(/<div[^>]*class="upcoming-events__card[^>]*>/).slice(1)) {
   const block=part.split('</a>')[0],date=text(block).match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/),name=text(block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1])
   const href=attrs(block.match(/<a\b[^>]*>/)?.[0]??'').href
   const venue=text(block.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1])
   if(date&&name&&href)events.push({name,url:href,source_page:url,...dateRange(`${date[2]} ${date[1]} ${date[3]}`),location:{name:venue},outside_scope:! /Kathmandu|Nagarkot|Patan|Panauti|Bungamati|Kirtipur|Bhaktapur|Patlekhet|Dhulikhel|Godavari/i.test(venue+' '+name)})
  }
 } else if(adapter==='takpa') {
  for(const m of html.matchAll(/<div[^>]*class="el-meta[^>]*>([\s\S]*?)<h3[^>]*>([\s\S]*?)<\/h3>/g)) {
   const date=text(m[1]).replace(/^(?:Ongoing\s+)+/i,''),dates=dateRange(date),name=text(m[2])
   if(dates)events.push({name,url:attrs(m[2].match(/<a[^>]*>/)?.[0]??'').href??url,source_page:url,...dates,location:{name:'Takpa Gallery'}})
  }
 } else if(adapter==='eventmanager') {
  for(const block of html.split(/<div[^>]*class="tourn-card-content"[^>]*>/).slice(1)) {
   const name=text(block.match(/class="tourn-name"[^>]*>([\s\S]*?)<\/div>/)?.[1]),pills=[...block.matchAll(/class="tourn-pill"[^>]*>([\s\S]*?)<\/div>/g)].map(m=>text(m[1])),dates=pills.map(dateRange).find(Boolean)
   if(name&&dates)events.push({name,url,source_page:url,...dates,location:{name:pills[0]},source_key:hash(name+'|'+dates.startDate)})
  }
 } else if(adapter==='vihaani') {
  for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
   const block=m[2],name=text(block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1]),t=text(block),d=t.match(/calendar_today\s*(.*?)\s*location_on\s*(.*?)\s*View Event Details/),dates=d&&dateRange(d[1])
   if(name&&dates)events.push({name,url:publicUrl(attrs(m[1]).href,url),source_page:url,...dates,location:{name:d[2]}})
  }
 } else if(adapter==='nada') {
  const d=clean.match(/Happening From[^()]*\(([^)]+)\)\s*([^]+?)\s*NADA Auto Show is/),dates=d&&dateRange(d[1])
  if(dates)events.push({name:text(html.match(/<title[^>]*>([\s\S]*?)\|/)?.[1])||'NADA Auto Show',url,source_page:url,...dates,location:{name:d[2]}})
 } else if(adapter==='kathasatha' && /\/events\/[^/]+/.test(new URL(url).pathname)) {
  for(const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
   const t=text(m[1]),d=t.match(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})\s+(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s+(.+)/i)
   const dates=d&&dateRange(d[1]);if(!dates||+d[2]<1||+d[2]>12||+(d[3]??0)>59)continue
   const startDate=dates.startDate+`T${String(+d[2]%12+(d[4].toUpperCase()==='PM'?12:0)).padStart(2,'0')}:${d[3]??'00'}:00+05:45`
   events.push({name:text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]).replace(/^KathaSatha - /,''),url,source_page:url,startDate,location:{name:d[5]}})
  }
 } else if(adapter==='artofliving') {
  const page=parseFragment(html)
  const find=(node,predicate)=>{
   if(!node||['script','style','template'].includes(node.tagName))return null
   if(predicate(node))return node
   for(const child of node.childNodes??[]){const match=find(child,predicate);if(match)return match}
   return null
  }
  const hasClass=(node,name)=>node.attrs?.find(a=>a.name==='class')?.value.split(/\s+/).includes(name)
  const byClass=(name,node=page)=>find(node,n=>hasClass(n,name))
  const nodeText=node=>{
   if(!node||['script','style','template'].includes(node.tagName))return ''
   return node.nodeName==='#text'?node.value:(node.childNodes??[]).map(nodeText).join(' ')
  }
  const value=node=>nodeText(node).replace(/\s+/g,' ').trim()
  const title=value(find(byClass('course-details-title'),n=>n.tagName==='b'))
  const date_text=value(byClass('course-details-combined_date')),dates=dateRange(date_text)
  const recurring=/^Every\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s*(?:,|and|&)\s*)?)+$/i.test(date_text)
  const location=value(byClass('course_venue_value',byClass('course-details-venue')))
  const time=value(byClass('course_weekday_value')??byClass('course_venue_value',byClass('course-details-times')))
  const registration=find(page,n=>n.tagName==='a'&&n.attrs?.some(a=>a.name==='data-sao-id'))
  const reg=Object.fromEntries((registration?.attrs??[]).map(a=>[a.name,a.value]))
  const courseId=value(byClass('course_detail_value',byClass('course-details-course-id')??{childNodes:[]}))
  if(title&&(dates||recurring))events.push({name:title,url,source_page:url,
   source_key:reg['data-sao-id']||courseId||hash(title+'|'+date_text),...dates,date_text,
   location:{name:location},description:'Published session times: '+time,offers:{url:reg.href?publicUrl(reg.href,url):null},
   ...(recurring?{review_only:true,review_reason:'Recurring weekly session: individual occurrence dates require review',recurrence_text:date_text,session_times:time}:{})})
 } else if(adapter==='pashupati') {
  const block=html.match(/class="scroll-date"[^>]*>([^<]+)<\/div>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/)?.[0]??''
  const day=text(block.match(/class="scroll-date"[^>]*>([^<]+)/)?.[1]).match(/^(\d+)-([A-Za-z]+)-(\d{4})/),date=day&&dateRange(`${day[2]} ${day[1]} ${day[3]}`)?.startDate
  if(date)for(const m of block.matchAll(/class="scroll-event"[^>]*>\s*<span[^>]*>([^<]+)<\/span>\s*<span[^>]*>([^<]+)<\/span>/g)) {
   const times=m[1].match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s*[-–]\s*(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
   if(!times)continue
   const stamp=(h,mi,ap)=>+h>=1&&+h<=12&&+mi<60?`${date}T${String(+h%12+(ap.toUpperCase()==='PM'?12:0)).padStart(2,'0')}:${mi}:00+05:45`:null
   const startDate=stamp(...times.slice(1,4)),endDate=stamp(...times.slice(4,7))
   if(startDate&&endDate)events.push({name:text(m[2]),url,source_page:url,source_key:date+'-'+text(m[2]),startDate,endDate,location:{name:'Pashupatinath Temple',address:{addressLocality:'Kathmandu'}}})
  }
 } else if(adapter==='happyclub') {
  for(const block of html.split(/<h3\b[^>]*>/i).slice(1)) {
   const a=block.match(/^\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i),m=text(block).match(/Event On\s*:\s*(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})\s+at\s+(\d+):(\d+)\s*(AM|PM)/i)
   if(!a||!m)continue
   const month='jan feb mar apr may jun jul aug sep oct nov dec'.split(' ').indexOf(m[2].toLowerCase().slice(0,3))+1
   if(!month||+m[4]<1||+m[4]>12||+m[5]>59)throw Error('Unsupported Happy Club date')
   const startDate=`${m[3]}-${String(month).padStart(2,'0')}-${m[1].padStart(2,'0')}T${String(+m[4]%12+(m[6].toUpperCase()==='PM'?12:0)).padStart(2,'0')}:${m[5]}:00+05:45`
   if(!explicitDate(startDate))throw Error('Invalid Happy Club date')
   events.push({name:text(a[2]),url:attrs(a[1]).href,source_page:url,startDate,location:{name:'Happy Club',address:{addressLocality:'Kathmandu'}},category:'Comedy'})
  }
 } else if(adapter==='paleti') {
  for(const e of objects(nuxtData(html)))if(e.slug&&e.start_date&&e.title&&e.venue){
   events.push({name:e.title,url:new URL('/#'+e.slug,url).href,source_key:e.slug,source_page:url,
    startDate:e.start_time?`${e.start_date}T${e.start_time}+05:45`:e.start_date,date_text:e.date_info,
    description:e.excerpt,location:{name:e.venue},image:e.full_featured_image??e.featured_image,
    eventStatus:e.completed?'EventCancelled':undefined})
  }
 } else if(adapter==='chautari') {
  for(const block of html.split(/<span\b[^>]*class="list-item-date[^" ]*(?:[^"]*)"[^>]*>/i).slice(1)) {
   const times=[...block.matchAll(/<time\b([^>]*)>/g)].map(m=>attrs(m[1]).datetime)
   const tag=block.match(/<a\b[^>]*class="list-item-link[^>]*>/)?.[0]
   if(tag&&times[0]){const a=attrs(tag);events.push({url:a.href,name:a.title,startDate:times[0],endDate:times[1],source_page:url})}
  }
 } else if(adapter==='siddhartha') {
  for(const block of html.split(/<div\b[^>]*class="el-content uk-panel uk-margin-top"[^>]*>/).slice(1)) {
   const t=text(block.split('</div>')[0]),m=t.match(/WHAT:\s*(.*?)\s*WHEN:\s*(.*?)\s*WHERE:\s*(.*)/i)
   if(m)events.push({name:m[1],date_text:m[2],location:{name:m[3]},source_page:url,url,source_key:hash(m[1]+'|'+m[2]),review_only:true})
  }
 } else if(adapter==='hasera') {
  const m=clean.match(/Our next (?:Int'l )?Permaculture Design Course \(PDC\) is (?:scheduled|planned) for ([^.]+\d{4})/i)
  if(m)events.push({name:'HASERA Permaculture Design Course',date_text:m[1],url,source_page:url,source_key:hash(m[1]),review_only:true,location:{name:'HASERA Permaculture Learning Center'}})
 } else if(adapter==='mandala') {
  const name=text(html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1])
  const dates=clean.match(/Start Date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})\s*End Date:\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i)
  if(name&&dates)events.push({name,url,source_page:url,date_text:`${dates[1]} – ${dates[2]}`,startDate:dateRange(dates[1])?.startDate,endDate:dateRange(dates[2])?.startDate,review_only:true,location:{name:'Mandala Theatre'},description:/No Shows/i.test(clean)?'No bookable shows listed.':''})
 } else if(adapter==='kopan') {
  const heading=[...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m=>text(m[1])).find(s=>/^ANNOUNCEMENT/i.test(s))
  if(heading)for(const m of html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
   const paragraph=text(m[1]),d=paragraph.match(/^On (\d{1,2}) ([A-Za-z]+) (\d{4}),/)
   if(!d||!/consecration|inaugurat/i.test(paragraph))continue
   const dates=dateRange(`${d[2]} ${d[1]} ${d[3]}`)
   if(dates)events.push({name:heading,url,source_page:url,source_key:'stupa-'+dates.startDate,...dates,location:{name:/at Kopan Nunnery/.test(paragraph)?'Kopan Nunnery':'Kopan Monastery'}})
  }
 }
 return events.map(e=>{const dates=dateRange(e.date_text);return dates?{...e,...dates,review_only:false}:e})
}
export function transform(raw,source,now=new Date().toISOString()) {
 const url=publicUrl(raw.url,source.url)
 if(!url || !raw.name)return {...raw,skip:'Missing source URL or title'}
 if(/EventCancelled|EventPostponed/.test(raw.eventStatus??''))return {...raw,skip:'Cancelled or postponed'}
 if(raw.outside_scope)return {...raw,skip:'Outside Kathmandu Valley / nearby coverage'}
 const country=raw.location?.address?.addressCountry
 if(typeof country==='string'&&country&&!/^(NP|NPL|Nepal)$/i.test(country))return {...raw,skip:'Explicitly outside Nepal; not a Valley event'}
 const start=explicitDate(raw.startDate),end=explicitDate(raw.endDate)
 if(!start && !raw.date_text)return {...raw,skip:'No explicit event date'}
 const today=new Date(now).toLocaleDateString('en-CA',{timeZone:'Asia/Kathmandu'})
 if((end??start)?.slice(0,10)<today)return {...raw,skip:'Past event'}
 const finish=end??start
 if(finish?.includes('T')&&!/T00:00(?::00)?(?:\.\d+)?(?:Z|[+-])/.test(finish)&&Date.parse(finish)<Date.parse(now))return {...raw,skip:'Event already ended'}
 const key=`venue:${source.id}:${raw.source_key??raw['@id']??hash(url+'|'+raw.name+'|'+(start??raw.date_text))}`
 const e=baseTransform({...raw,name:text(raw.name),description:text(raw.description),url:'https://katajaam.com/events/'+hash(key),startDate:start,endDate:end}, {},false,now)
 if(e.skip)return {...e,url}
 e.description=e.description.replace(/Source: https:\/\/katajaam.com\/events\/\S+/,'Source: '+url)
 if(raw.date_text||start?.length===10)e.description+=`\n\nSource dates: ${raw.date_text??[start,end].filter(Boolean).join(' – ')}`
 if(!start||start.length===10)e.warnings.push('Source dates require review; no time invented')
 if(raw.review_only)e.warnings.push('Unstructured date range; verify future/ongoing dates manually')
 if(start && /T00:00(?::00)?(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(start)) {
  e.starts_at=null;e.ends_at=null;e.warnings.push('Midnight timestamp may be a placeholder; confirm time')
  e.description+=`\n\nSource timestamp requiring time review: ${start}`
 }
 if(start && start.length===10)e.ends_at=null
 // Shared listing-page URLs can contain several occurrences. A fragment keeps
 // the existing import planner's URL identity distinct without changing the host.
 const identityUrl=url+'#nepscene-'+hash(key)
 return {...e,id:'ve_'+hash(key),source_id:key,fingerprint:'venue:'+hash(e.fingerprint),url:identityUrl,status:'draft'}
}
