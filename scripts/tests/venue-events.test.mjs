import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { text,structuredEvents,explicitDate,tribeEvents,customEvents,transform,plan,nuxtData,dateRange } from '../lib/venue-events.mjs'
import { reader,crawlSource,eventLinks,sameSite,coalesceEvents } from '../scrape-venues.mjs'
const source={id:'ktm-test',name:'Example',url:'https://example.org/',evidence:'Official website',collection:true}
const now='2026-09-11T00:00:00Z'
const raw={name:'Concert',url:source.url,startDate:'2026-09-25T17:00:00+05:45',location:{name:'Hall',address:{addressLocality:'Kathmandu'}},image:'https://example.org/poster.jpg'}
test('race stage details replace parent overviews without collapsing distinct stages',()=>{
 const parent={url:'https://race.trailmandu.com/races/series',image:'poster.jpg'}
 const stages=[1,2,3,4].map(i=>({url:parent.url+'?stage_id='+i,startDate:'2026-10-0'+i}))
 const standalone={url:'https://race.trailmandu.com/races/standalone'}
 const result=coalesceEvents([parent,...stages,standalone],{id:'ktm-154'})
 assert.equal(result.length,5);assert.equal(result[0].image,'poster.jpg');assert.equal(result[3].startDate,'2026-10-04')
 assert.ok(result.includes(standalone));assert.deepEqual(coalesceEvents([parent],{id:'ktm-154'}),[parent])
 assert.equal(coalesceEvents([parent,...stages],source).length,5)
})
test('nested JSON-LD only extracts actual events, not article publication dates',()=>{
 const html='<script type="application/ld+json">'+JSON.stringify({'@graph':[{'@type':'Article',name:'News',datePublished:raw.startDate},{'@type':['Thing','MusicEvent'],...raw}]})+'</script>'
 assert.equal(structuredEvents(html,source.url).events.length,1)
 assert.equal(structuredEvents('<script type="application/ld+json">broken</script>',source.url).errors.length,1)
})
test('invalid calendar dates and naive timestamps are not accepted',()=>{
 for(const d of ['2026-02-30','2026-13-01','2026-09-12T12:00','2026-09-12T25:00:00+05:45','Every Tuesday','2083 भदौ २६'])assert.equal(explicitDate(d),null)
 assert.equal(explicitDate('2028-02-29'),'2028-02-29')
})
test('date-only is draft without invented midnight; cancelled and past events excluded',()=>{
 const e=transform({...raw,startDate:'2026-09-25'},source,now)
 assert.equal(e.starts_at,null);assert.equal(e.status,'draft')
 assert.ok(transform({...raw,startDate:'2020-01-01'},source,now).skip)
 assert.ok(transform({...raw,eventStatus:'https://schema.org/EventCancelled'},source,now).skip)
 assert.ok(transform({...raw,startDate:'2026-02-30'},source,now).skip)
})
test('ongoing multi-day events retained; new records always drafts',()=>{
 const e=transform({...raw,startDate:'2026-09-10',endDate:'2026-09-20'},source,now)
 assert.equal(e.status,'draft');assert.equal(e.starts_at,null)
 assert.equal(transform(raw,source,now).starts_at,'2026-09-25T11:15:00.000Z')
})
test('stable identities do not collapse multiple events at the same listing URL',()=>{
 const a=transform(raw,source,now),b=transform({...raw,name:'Second Concert'},source,now)
 assert.equal(a.source_id,transform(raw,source,now).source_id)
 assert.deepEqual(plan([a,b,a]).map(x=>x.action),['insert','insert','duplicate'])
 assert.ok(a.description.endsWith('Source: '+source.url))
})
test('Tribe API uses UTC timestamps and does not assume unknown prices are free',()=>{
 const [e]=tribeEvents({total_pages:1,events:[{id:2,title:'Dance',url:source.url,utc_start_date:'2026-09-12 12:00:00',utc_end_date:'2026-09-12 14:00:00'}]},source.url)
 assert.equal(e.startDate,'2026-09-12T12:00:00Z');assert.equal(e.isAccessibleForFree,undefined)
 assert.throws(()=>tribeEvents({events:[]},source.url))
})
test('Happy Club extracts individual dated cards',()=>{
 const html='<h3><a href="https://example.org/event/one">Comedy Night</a></h3><p>Event On : 25th Sep, 2026 at 7:00 PM, Friday</p>'
 const [e]=customEvents(html,source.url,'happyclub')
 assert.equal(e.startDate,'2026-09-25T19:00:00+05:45');assert.equal(e.name,'Comedy Night')
})
test('Chautari uses event datetime attributes rather than news dates',()=>{
 const html='<span class="list-item-date small">On <time datetime="2026-09-13T15:00:00+05:45">13 September 2026</time></span><a class="list-item-link small" href="https://example.org/events/talk" title="Talk">More</a>'
 assert.equal(customEvents(html,source.url,'chautari')[0].startDate,'2026-09-13T15:00:00+05:45')
})
test('Siddhartha and HASERA retain date-range evidence in manual review',()=>{
 const html='<div class="el-content uk-panel uk-margin-top"><p>WHAT: Exhibition WHEN: August 28 – September 20, 2026 WHERE: Gallery</p></div>'
 assert.equal(customEvents(html,source.url,'siddhartha')[0].startDate,'2026-08-28')
 assert.equal(customEvents("Our next Int'l Permaculture Design Course (PDC) is scheduled for Sept 26 - Oct 9 2026.",source.url,'hasera')[0].date_text,'Sept 26 - Oct 9 2026')
})
test('only same-site links; no template placeholders, old month navigation or files',()=>{
 const links=eventLinks('<a href="/events/one">One</a><a href="/events/2026-08/">Previous</a><a href="/events/[[=permalink]]">Template</a><a href="https://evil.org/event">Other</a><a href="/events/a.pdf">PDF</a>',source.url)
 assert.deepEqual(links,['https://example.org/events/one'])
 assert.equal(sameSite('https://example.org.evil.org/',source.url),false)
 assert.equal(sameSite('http://127.0.0.1/',source.url),false)
})
test('empty, unsupported, failure and partial remain distinguishable',async()=>{
 const run=read=>crawlSource(source,{read,now})
 assert.equal((await run(async url=>({body:'No upcoming events found.',url}))).status,'empty')
 assert.equal((await run(async url=>({body:'Contact us for venue hire',url}))).status,'unsupported')
 assert.equal((await run(async()=>{throw Error('HTTP 403')})).status,'failed')
 assert.equal((await run(async url=>({body:'<script type="application/ld+json">bad</script>',url}))).status,'partial')
})
test('Tribe pagination follows all pages and reports page-limit truncation',async()=>{
 const calls=[]
 const read=async url=>{calls.push(url);return {url,body:url.includes('wp-json')?JSON.stringify({total_pages:2,events:[]}):'<a href="https://example.org/wp-json/tribe/events/v1/">API</a>'}}
 const r=await crawlSource(source,{read,now,maxPages:4})
 assert.equal(r.status,'empty');assert.equal(calls.length,3)
 const short=await crawlSource(source,{read,now,maxPages:2})
 assert.equal(short.status,'partial');assert.match(short.errors[0],/limit/)
})
test('Nuxt indexed payload is decoded as data; Paleti retains its announced time',()=>{
 const pool=[{data:1},{events:2},[3],{slug:4,title:5,start_date:6,start_time:7,venue:8},'concert','Concert','2026-09-25','17:50:00','r-sala']
 const html='<script type="application/json" id="__NUXT_DATA__">'+JSON.stringify(pool)+'</script>'
 assert.equal(nuxtData(html).data.events[0].title,'Concert')
 assert.equal(customEvents(html,source.url,'paleti')[0].startDate,'2026-09-25T17:50:00+05:45')
})
test('millisecond timestamps parse, but midnight stays unknown rather than 05:45 Nepal time',()=>{
 const e=transform({...raw,startDate:'2026-09-25T00:00:00.000Z'},source,now)
 assert.equal(e.starts_at,null);assert.ok(e.warnings.some(w=>w.includes('placeholder')))
 assert.equal(explicitDate('2026-09-25T12:30:00.123Z'),'2026-09-25T12:30:00.123Z')
})
test('date ranges validate same-month and cross-month dates; do not infer missing year',()=>{
 assert.deepEqual(dateRange('Sept 26 - Oct 9, 2026'),{startDate:'2026-09-26',endDate:'2026-10-09'})
 assert.deepEqual(dateRange('May 12 – 25, 2026'),{startDate:'2026-05-12',endDate:'2026-05-25'})
 for(const s of ['May 12 – 25','February 30, 2026','October 9 – September 26, 2026'])assert.equal(dateRange(s),null)
})
test('Mandala dates are extracted even when Viewing Times heading is commented out',()=>{
 const html='<h3>Play</h3><p>Start Date: September 24, 2026</p><p>End Date: September 30, 2026</p><!-- Viewing Times -->No Shows..'
 const [e]=customEvents(html,source.url,'mandala')
 assert.equal(e.startDate,'2026-09-24');assert.equal(e.endDate,'2026-09-30');assert.equal(e.review_only,true)
})
test('Kopan announcements remain separate date-only occurrences',()=>{
 const html='<h1>ANNOUNCEMENT: CEREMONIES</h1><p>On 11 December 2026, a grand consecration at Kopan Monastery.</p><p>On 14 December 2026, a consecration at Kopan Nunnery.</p>'
 const events=customEvents(html,source.url,'kopan')
 assert.equal(events.length,2);assert.equal(events[1].location.name,'Kopan Nunnery')
 assert.equal(plan(events.map(e=>transform(e,source,now))).filter(e=>e.action==='insert').length,2)
})
test('explicit foreign events are excluded; stable schema IDs survive corrections',()=>{
 assert.ok(transform({...raw,location:{address:{addressCountry:'Cambodia'}}},source,now).skip)
 const a=transform({...raw,'@id':'https://example.org/events/1'},source,now)
 const b=transform({...raw,'@id':'https://example.org/events/1',name:'Corrected',startDate:'2026-09-26T17:00:00+05:45'},source,now)
 assert.equal(a.source_id,b.source_id)
})
test('enabled sources fail visibly on layout changes, rather than silently reporting zero',async()=>{
 const r=await crawlSource({...source,enabled:true},{read:async url=>({url,body:'New site layout'}),now})
 assert.equal(r.status,'partial');assert.match(r.errors[0],/markup missing/)
})
test('events that already ended earlier today are excluded',()=>{
 assert.ok(transform({...raw,startDate:'2026-09-11T04:00:00+05:45',endDate:'2026-09-11T05:00:00+05:45'},source,'2026-09-11T12:00:00Z').skip)
})
for(const [adapter,count,date] of [['ieff',2,'2027-03-16'],['royalmt',1,'2026-12-24'],['eventmanager',1,'2026-05-16'],['takpa',1,'2026-08-22'],['pashupati',2,'2026-09-11T04:00:00+05:45'],['chautari',1,'2026-09-13T15:00:00+05:45'],['happyclub',1,'2026-09-01T19:00:00+05:45'],['paleti',1,'2026-09-25T17:50:00+05:45']]) {
 test(`captured ${adapter} markup retains source dates`,()=>{
  const html=readFileSync(new URL(`./fixtures/venues/${adapter}.html`,import.meta.url),'utf8')
  const events=customEvents(html,source.url,adapter)
  assert.equal(events.length,count);assert.equal(events[0].startDate,date)
 })
}

test('HTML text extraction skips comments and executable content and decodes entities once',()=>{
 assert.equal(text('<p>Music &amp; art</p><!-- hidden --><script>bad()</script ><style>body{}</style ><p>Tonight</p>'),'Music & art Tonight')
 assert.equal(text('<!-- outer <!-- nested -->Visible'),'Visible')
 assert.equal(text('&lt;script&gt;literal&lt;/script&gt; &amp;lt;b&amp;gt;'),'<script>literal</script> &lt;b&gt;')
})
test('structured scripts accept HTML closing-tag whitespace and ignore commented-out scripts',()=>{
 const event=JSON.stringify({'@type':'Event',...raw})
 const html='<!-- <script type="application/ld+json">'+event+'</script> -->' +
  '<script type="application/ld+json">'+event+'</script >'
 assert.equal(structuredEvents(html,source.url).events.length,1)
 const nuxt="<script id='__NUXT_DATA__' type='application/json'>[{}]</script >"
 assert.deepEqual(nuxtData(nuxt),{})
})
test('reader rejects off-site requests and redirects before sending another request',async t=>{
 const calls=[]
 t.mock.method(globalThis,'fetch',async url=>{
  calls.push(url)
  return {status:302,headers:{get:()=> 'https://example.org.evil.org/events'},body:{cancel:async()=>{}}}
 })
 const read=reader(source,{pace:0})
 await assert.rejects(read('https://example.org.evil.org/events'),/Cross-site request refused/)
 assert.equal(calls.length,0)
 await assert.rejects(read(source.url),/Cross-site redirect refused/)
 assert.deepEqual(calls,[source.url])
})
