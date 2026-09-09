#!/usr/bin/env node
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
const out=resolve(process.argv[2]??'.khalti-scrape')
const response=await fetch('https://events.khalti.com/',{signal:AbortSignal.timeout(60000)})
if(!response.ok) throw Error(`HTTP ${response.status}`)
const html=await response.text()
const match=html.match(/<script\b[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
if(!match) throw Error('Page format changed: no structured listing data')
const data=JSON.parse(match[1])
const queries=data.props?.pageProps?.dehydratedState?.queries??[]
const listing=queries.map(q=>q.state?.data).find(d=>Array.isArray(d?.events))
if(!listing) throw Error('No event inventory found')
const all=[...listing.events,...(listing.upcoming_events??[])]
const seen=new Set(), events=[], skipped=[]
const now=new Date()
for(const raw of all){
 if(!raw.idx || !raw.title) throw Error('Invalid event identity')
 if(seen.has(raw.idx)) continue
 seen.add(raw.idx)
 const e={source_id:`khalti:${raw.idx}`,title:raw.title,url:`https://events.khalti.com/events/${raw.idx}`,starts_at:raw.start_date??null,venue:raw.location??null,city:raw.city??null,genres:raw.genres??[],image_url:raw.web_image_url??raw.image_url,is_free:raw.is_free,is_sold_out:raw.is_sold_out,source_price:raw.price??null,has_children:raw.has_children,raw}
 // Do not turn parent festival/tour dates into individual session dates.
 let reason=raw.has_children?'Parent listing: individual sessions need inspection':null
 if(!reason && (!raw.start_date || !/T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(raw.start_date) || !Number.isFinite(Date.parse(raw.start_date)))) reason='Missing explicit start date/time'
 if(!reason && Date.parse(raw.start_date)<now.getTime()) reason='Past start date/time'
 if(reason) skipped.push({...e,reason}); else events.push(e)
}
if(!seen.size) throw Error('Empty inventory; refusing silent success')
mkdirSync(out,{recursive:true})
const result={checked_at:now.toISOString(),source:'https://events.khalti.com/',scope:'Public homepage events and upcoming_events; excludes past archive and does not expand parent sessions. Descriptions/organizers not fetched. Prices retained in raw source units.',source_entries:seen.size,eligible:events.length,skipped_count:skipped.length,events,skipped}
writeFileSync(join(out,'khalti-events.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify({source_entries:seen.size,eligible:events.length,skipped:skipped.length,file:join(out,'khalti-events.json')},null,2))
