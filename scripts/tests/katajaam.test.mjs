import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { transform, plan, buildSql, eventPage, listingPage, crawl, sameEvent } from '../lib/katajaam.mjs'
import { options, runWrangler, parseD1Output } from '../import-katajaam.mjs'

const now = '2026-09-09T00:00:00.000Z'
const raw = (id='a', changes={}) => ({ '@type':'Event',url:`https://katajaam.com/events/${id}`,
  name:'Wellness Run — For Flood Relief',startDate:'2026-09-19T07:00:00+05:45',
  description:"Run for schools. It's a community event.",category:'Sports & Fitness',
  location:{name:'Dasharath Stadium, Tripureshwor',address:{addressLocality:'Kathmandu'},geo:{latitude:27.695,longitude:85.3149}},
  organizer:{name:'Jeevan Vigyan Youth'},image:['https://example.com/poster.jpg'],
  isAccessibleForFree:false,offers:{price:500,priceCurrency:'NPR',url:'https://example.com/event'}, ...changes })
const map = (r, override={},publish=false) => transform(r,override,publish,now)
function db() {
  const database = new DatabaseSync(':memory:')
  const dir = fileURLToPath(new URL('../../migrations/',import.meta.url))
  const base = existsSync(join(dir, '0001_catalogue_core.sql')) ? dir : fileURLToPath(new URL('../../../migrations/', import.meta.url))
  const migrations = new Map([base, dir].flatMap((folder) => readdirSync(folder).filter((f) => f.endsWith('.sql')).map((f) => [f, join(folder, f)])))
  for (const [, file] of [...migrations].sort(([a], [b]) => a.localeCompare(b))) database.exec(readFileSync(file, 'utf8'))
  database.exec('PRAGMA foreign_keys=ON')
  return database
}
test('converts Nepal time to UTC and preserves unknown prices and string images',()=>{
  const e=map(raw('a',{image:'https://example.com/single.jpg',offers:{price:null,url:'https://example.com/tickets'}}))
  assert.equal(e.starts_at,'2026-09-19T01:15:00.000Z')
  assert.equal(e.offer_price_from_paisa,null)
  assert.equal(e.cover_image_url,'https://example.com/single.jpg')
  assert.equal(e.status,'draft')
  assert.equal(map(raw()).offer_price_from_paisa,50000)
})
test('unknown dates and placeholder midnight remain draft even with publish',()=>{
  assert.equal(map(raw('a',{date_tbd:true}),{},true).starts_at,null)
  assert.equal(map(raw('a',{startDate:'2026-09-19T00:00:00+05:45'}),{},true).status,'draft')
  assert.equal(map(raw(),{},true).status,'published')
  assert.equal(map(raw('a',{date_tbd:true}),{starts_at:'2026-10-01T19:00:00+05:45'},true).status,'published')
})
test('test entries, invalid URLs and external pagination fail safely',()=>{
  assert.ok(map(raw('x',{name:'Test event'})).skip)
  assert.throws(()=>map(raw('x',{url:'https://bad.example/events/a'})))
  assert.throws(()=>listingPage('<main>1 events across the valley<a href="https://bad.example/">Next</a></main>'))
})
test('pagination pages expose counts under Events rather than the first-page banner',()=>{
  assert.equal(listingPage('<main><h2>Events</h2><span>61<!-- --> events</span></main>').count,61)
  assert.equal(listingPage('<main><span>61<!-- --> event<!-- -->s across the valley</span></main>').count,61)
})
test('parses event JSON-LD, double entities, and own TBD rather than related dates',()=>{
  const e=raw('a',{name:'Jumpin&#x27; Bars &amp; Friends'})
  const page=`<main><h1>Title</h1><h2>At a glance</h2><div>When</div><div>To be decided</div></main><script type="application/ld+json">${JSON.stringify(e)}</script>`
  const parsed=eventPage(page,e.url)
  assert.equal(parsed.date_tbd,true)
  assert.equal(map(parsed).title,"Jumpin' Bars & Friends")
  const dated=page.replace('<div>To be decided</div>','<div>19 September</div><h2>More</h2><div>To be decided</div>')
  assert.equal(eventPage(dated,e.url).date_tbd,false)
})
test('inventory walks pagination, verifies count and deduplicates repeated cards',async()=>{
  const a=raw('a'), b=raw('b')
  const card=(r)=>`<a href="/events/${r.url.split('/').at(-1)}"><img src="x"><h3>Title</h3></a>`
  const pages={
    'https://katajaam.com/sitemap.xml':`<urlset><loc>${a.url}</loc><loc>${b.url}</loc></urlset>`,
    'https://katajaam.com/events':`<main>2 events across the valley${card(a)}<a href="/events?page=1">Next</a></main>`,
    'https://katajaam.com/events?page=1':`<main>2 events across the valley${card(a)}${card(b)}</main>`,
    [a.url]:`<script type="application/ld+json">${JSON.stringify(a)}</script>`,
    [b.url]:`<script type="application/ld+json">${JSON.stringify(b)}</script>`,
  }
  assert.equal((await crawl(async(u)=>pages[u])).count,2)
  pages['https://katajaam.com/events?page=1']='<main>2 events across the valley</main>'
  await assert.rejects(crawl(async(u)=>pages[u]),/incomplete/)
})
test('different source IDs for the same Wellness Run merge; different dates do not',()=>{
  const a=map(raw()),b=map(raw('b',{name:'Wellness Run for Flood Reliefs'}))
  assert.ok(sameEvent(a,b))
  assert.deepEqual(plan([a,b]).map((e)=>e.action),['insert','duplicate'])
  assert.equal(sameEvent(a,map(raw('c',{startDate:'2026-09-20T07:00:00+05:45'}))),false)
})
test('source identity survives title/date changes and matches manual listings',()=>{
  const a=map(raw()),changed=map(raw('a',{name:'New title',startDate:'2026-10-01T07:00:00+05:45'}))
  assert.equal(plan([changed],[{...a,import_source_id:a.source_id}])[0].action,'duplicate')
  assert.equal(plan([changed],[{...a,id:'manual'}],[{source_id:a.source_id,listing_id:'manual'}])[0].listing_id,'manual')
  assert.equal(plan([a],[{...a,id:'manual',url:null}])[0].listing_id,'manual')
})
test('real schema: repeat SQL and repeat plans do not duplicate events, venues or organizers',()=>{
  const d=db(), a=map(raw()), b=map(raw('b',{name:'Wellness Run for Flood Reliefs'}))
  const sql=buildSql(plan([a,b]));d.exec(sql);d.exec(sql)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM listings').get().n,1)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM import_sources').get().n,2)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM venues').get().n,1)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM organizations').get().n,1)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,1)
  assert.deepEqual(d.prepare('PRAGMA foreign_key_check').all(),[])
  d.close()
})
test('SQL constraints protect separately prepared concurrent runs and edited listings',()=>{
  const d=db(),a=map(raw()),b=map(raw('b',{name:'Wellness Run for Flood Reliefs'}))
  d.exec(buildSql(plan([a])))
  d.exec(buildSql(plan([b])))
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM listings').get().n,1)
  d.exec(`UPDATE listings SET title='Editor title',status='archived'; DELETE FROM listing_categories; INSERT INTO listing_categories VALUES ('${a.id}','cat_community',1);`)
  d.exec(buildSql(plan([a])))
  assert.equal(d.prepare('SELECT title FROM listings').get().title,'Editor title')
  assert.equal(d.prepare('SELECT status FROM listings').get().status,'archived')
  assert.equal(d.prepare('SELECT category_id FROM listing_categories').get().category_id,'cat_community')
  d.close()
})
test('interrupted import recovers safely, and source text cannot execute SQL',()=>{
  const d=db(), e=map(raw('a',{description:"'); DROP TABLE users; --"}))
  const sql=buildSql(plan([e])), statements=sql.split('\n')
  d.exec(statements.slice(0,2).join('\n'))
  d.exec(sql)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM listings').get().n,1)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM import_sources').get().n,1)
  assert.ok(d.prepare('SELECT name FROM sqlite_master WHERE name=\'users\'').get())
  d.close()
})
test('CLI defaults to preview and refuses conflicting or unknown options',()=>{
  assert.equal(options([]).apply,false)
  assert.equal(options([]).env,null)
  assert.throws(()=>options(['--apply','--dry-run']))
  assert.throws(()=>options(['--env']))
  assert.throws(()=>options(['--unknown']))
  assert.equal(options(['--env','production','--apply']).env,'production')
})

test('Wrangler failures expose captured D1 diagnostics', () => {
  assert.throws(() => runWrangler([], {}, () => {
    throw Object.assign(new Error('Command failed'), {
      status: 1, stdout: '{"error":{"text":"D1_RESET_DO"}}', stderr: 'Wrangler diagnostics',
    })
  }), (error) => {
    assert.match(error.message, /exit 1/)
    assert.match(error.message, /D1_RESET_DO/)
    assert.match(error.message, /Wrangler diagnostics/)
    return true
  })
})

test('D1 JSON parsing accepts import progress but rejects failures and malformed output', () => {
  const json = JSON.stringify([{ success: true, results: [{ id: 'listing' }] }], null, 2)
  assert.deepEqual(parseD1Output(json), [{ id: 'listing' }])
  assert.deepEqual(parseD1Output(`├ Checking upload\n[progress] uploading\n🌀 Processed 285 queries.\n${json}\n`), [{ id: 'listing' }])
  assert.throws(() => parseD1Output('Progress only'), /valid D1 JSON/)
  assert.throws(() => parseD1Output('[{"success":true}'), /valid D1 JSON/)
  assert.throws(() => parseD1Output('[{"success":false,"error":"SQL failed"}]'), /SQL failed/)
  assert.throws(() => parseD1Output('{"error":"D1_RESET_DO"}'), /D1_RESET_DO/)
  assert.throws(() => parseD1Output('[{}]'), /unsuccessful/)
})
