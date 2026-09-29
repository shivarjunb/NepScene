#!/usr/bin/env node
import { writeFileSync,mkdirSync } from 'node:fs'
import { resolve,dirname,join } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Buffer } from 'node:buffer'
import { attrs,publicUrl,structuredEvents,customEvents,tribeEvents,transform,plan,text } from './lib/venue-events.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
// The checked-in registry is part of the scraper, not an arbitrary input file.
import registry from './venue-sources.json' with { type: 'json' }
export const sources=registry
export function sameSite(url,base) {
 const a=new URL(url),b=new URL(base)
 return /^https?:$/.test(a.protocol)&&!a.username&&!a.password&&a.hostname.replace(/^www\./,'')===b.hostname.replace(/^www\./,'')&&a.port===b.port
}
export function coalesceEvents(events,source) {
 if(source.id!=='ktm-154')return events
 const path=e=>{try {const u=new URL(e.url);return u.origin+u.pathname}catch{return null}}
 const stages=events.filter(e=>{try{return new URL(e.url).searchParams.has('stage_id')}catch{return false}})
 const stagePaths=new Set(stages.map(path))
 const parents=new Map(events.filter(e=>!stages.includes(e)).map(e=>[path(e),e]))
 return events.filter(e=>stages.includes(e)||!stagePaths.has(path(e))).map(e=>{
  const parent=parents.get(path(e));return parent&&stages.includes(e)?{...e,image:e.image??parent.image,organizer:e.organizer??parent.organizer}:e
 })
}
export function eventLinks(html,base,source = {}) {
 const urls=[]
 for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
  const a=attrs(m[1]),u=publicUrl(a.href,base);if(!a.href||!u||!sameSite(u,base))continue
  const p=new URL(u)
  if(source.id==='ktm-154' && !/^\/races(?:\/[^/]+)?\/?$/.test(p.pathname))continue
  if(/\[|\]|[{}]/.test(u)||/past|archive|event-categories|event-history|post-show|\/events\/\d{4}-\d{2}/i.test(p.pathname))continue
  if(/\.(?:css|js|jpg|jpeg|png|webp|pdf|zip|mp4)\b/i.test(p.pathname)||/wp-admin|logout|login|register|cart|checkout|oembed/i.test(p.pathname))continue
  if(/event|calendar|programme|program|shows|whats-on|exhibition|retreat|course|view-drama|session|race/i.test(p.pathname+' '+text(m[2])) && !/book-a-show|meeting-event|conference-event|inquiry/i.test(p.pathname))urls.push(u)
 }
 return [...new Set(urls)]
}
export function reader(source,{timeout=15000,pace=350}={}) {
 let last=0
 return async function read(value) {
  let url=value
  for(let redirects=0;redirects<=4;redirects++) {
   if(!sameSite(url,source.url))throw Error('Cross-site request refused: '+url)
   await delay(Math.max(0,pace-(Date.now()-last)));last=Date.now()
   let response
   for(let attempt=0;attempt<3;attempt++) {
    response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(timeout),headers:{'User-Agent':'NepScene-VenueEvents/1.0',Accept:'text/html,application/json'}})
    if((response.status===429||response.status>=500)&&attempt<2){await response.body?.cancel();await delay(1000*2**attempt);continue}break
   }
   if([301,302,303,307,308].includes(response.status)) {
    const target=publicUrl(response.headers.get('location'),url);await response.body?.cancel()
    if(!target||!sameSite(target,source.url))throw Error('Cross-site redirect refused: '+target)
    url=target;continue
   }
   if(!response.ok){await response.body?.cancel();throw Error(`HTTP ${response.status}: ${url}`)}
   const parts=[];let bytes=0
   for await(const chunk of response.body) {bytes+=chunk.length;if(bytes>3_000_000)throw Error('Source page exceeds 3 MB');parts.push(chunk)}
   return {body:Buffer.concat(parts).toString('utf8'),url}
  }
  throw Error('Too many redirects')
 }
}
export async function crawlSource(source,{read=reader(source),maxPages=25,now=new Date().toISOString()}={}) {
 const report={id:source.id,name:source.name,url:source.url,pages:[],errors:[],events:[],review:[],status:'unsupported'}
 if(source.existing){report.status='existing-scraper';report.existing=source.existing;return report}
 if(!source.evidence.startsWith('Official')){report.status='reference-only';return report}
 const queue=[...(source.seeds??[]),source.url],seen=new Set(),raw=[],apis=new Set()
 const home=new URL('/',source.url).href;if(!source.collection && !queue.includes(home))queue.push(home)
 let supported=false,empty=false
 while(queue.length&&seen.size<maxPages) {
  const request=queue.shift();if(seen.has(request))continue;seen.add(request)
  try {
   const {body,url}=await read(request);report.pages.push(url)
   if(/\/wp-json\/tribe\/events\/v1\/events(?:\?|$)/.test(url)) {
    const data=JSON.parse(body),entries=tribeEvents(data,url);raw.push(...entries);supported=true;empty||=entries.length===0
    const page=Number(new URL(url).searchParams.get('page')??1)
    if(page<data.total_pages){const next=new URL(url);next.searchParams.set('page',String(page+1));queue.unshift(next.href)}
    continue
   }
   const parsed=structuredEvents(body,url);raw.push(...parsed.events);report.errors.push(...parsed.errors);supported||=parsed.events.length>0
   const custom=customEvents(body,url,source.adapter);raw.push(...custom);supported||=custom.length>0
   empty||=/No upcoming events found|No Shows\.\./i.test(text(body))
   for(const m of body.matchAll(/https?:[^"'<>\s]+\/wp-json\/tribe\/events\/v1\//g)) {
    const api=decodeURI(m[0])+'events?per_page=50&page=1&start_date='+now.slice(0,10)
    if(sameSite(api,url)&&!apis.has(api)){apis.add(api);queue.unshift(api)}
   }
   // A discovered paginated calendar API is authoritative; do not also walk
   // an infinite previous-month calendar. Collection adapters parse their cards.
   if(!apis.size && !source.collection)for(const link of eventLinks(body,url,source))if(!seen.has(link)&&!queue.includes(link))queue.push(link)
   if(source.collection)for(const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a=attrs(m[1]);if(a.rel==='next'||/^(Next|Older)(?:\s|$)/i.test(text(m[2]))) {
     const next=publicUrl(a.href,url);if(next&&sameSite(next,url)&&!seen.has(next)&&!queue.includes(next))queue.push(next)
    }
   }
  }catch(error){report.errors.push(error.message+(error.cause?.code?' ('+error.cause.code+')':''))}
 }
 if(queue.some(u=>!seen.has(u)))report.errors.push(`Page limit ${maxPages} reached; coverage is partial`)
 const unique=new Map()
 for(const e of coalesceEvents(raw,source)){const key=e.source_key??(e.url+'|'+e.name+'|'+e.startDate);if(!unique.has(key))unique.set(key,e)}
 report.events=[...unique.values()].filter(e=>!e.review_only).map(e=>({...e,source_id:source.id}))
 report.review=[...unique.values()].filter(e=>e.review_only).map(e=>({...e,source_id:source.id}))
 if(source.enabled && !supported && !empty && !report.errors.length)report.errors.push('Expected event markup missing; layout or source data changed')
 report.status=report.errors.length?(report.pages.length?'partial':'failed'):supported?(raw.length?'parsed':'empty'):empty?'empty':'unsupported'
 return report
}
export async function main(args=process.argv.slice(2)) {
 let out=join(root,'scrape-output','venues'),selected=sources.filter(s=>s.enabled),maxPages=25
 for(let i=0;i<args.length;i++) {
  const a=args[i]
  if(a==='--scrape-only')continue
  if(a==='--audit'){selected=sources;continue}
  if(a==='--out'){if(!args[i+1])throw Error('Missing --out');out=resolve(args[++i])}
  else if(a==='--source'){const ids=args[++i]?.split(',');selected=sources.filter(s=>ids?.includes(s.id));if(!selected.length||selected.length!==new Set(ids).size)throw Error('Unknown --source ID')}
  else if(a==='--max-pages'){maxPages=Number(args[++i]);if(!Number.isInteger(maxPages)||maxPages<1||maxPages>200)throw Error('--max-pages must be 1–200')}
  else if(a==='--help'){console.log('node scripts/scrape-venues.mjs [--source ktm-026,ktm-160 | --audit] [--out DIR] [--max-pages 25]\nDefault: validated sources. --audit probes the full lead registry. Scrape only; saves inventory, draft candidates, manual-review entries and coverage.');return}
  else throw Error('Unknown argument: '+a)
 }
 mkdirSync(out,{recursive:true});const checked_at=new Date().toISOString(),reports=[]
 let index=0
 async function worker() {while(index<selected.length){const source=selected[index++];const r=await crawlSource(source,{maxPages,now:checked_at});reports.push(r);writeFileSync(join(out,source.id+'.json'),JSON.stringify(r,null,2));console.log(`${source.id} ${source.name}: ${r.status}, ${r.events.length} entries, ${r.review.length} review`);for(const error of r.errors)console.error(`${source.id}: ${error}`)}}
 await Promise.all(Array.from({length:4},worker))
 reports.sort((a,b)=>a.id.localeCompare(b.id))
 const events=reports.flatMap(r=>r.events),review=reports.flatMap(r=>r.review)
 const candidates=events.map(e=>transform(e,sources.find(s=>s.id===e.source_id),checked_at))
 writeFileSync(join(out,'inventory.json'),JSON.stringify({checked_at,events},null,2))
 writeFileSync(join(out,'review.json'),JSON.stringify(review,null,2))
 writeFileSync(join(out,'report.json'),JSON.stringify({mode:'scrape-only',checked_against_database:false,checked_at,events:plan(candidates)},null,2))
 writeFileSync(join(out,'coverage.json'),JSON.stringify({checked_at,sources:reports.map(({events,review,...r})=>({...r,event_count:events.length,review_count:review.length}))},null,2))
 if(reports.some(r=>['partial','failed'].includes(r.status)))process.exitCode=1
 console.log('Results: '+out)
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e);process.exitCode=1})
