import test from 'node:test'
import assert from 'node:assert/strict'
import {startTime,transform,plan,listingPage,eventPage} from '../lib/taragaon.mjs'
test('retains registration URL when source anchor points to hash',()=>{
 const html='<p class="event-date">September 27, 2026 | 10 am</p><div class="tickets_value"><div><p><a href="#">https://docs.google.com/forms/example</a></p></div></div><div class="elementor-widget-theme-post-content"><div><p>Example description</p></div></div>'
 assert.equal(eventPage(html,{url:'https://taragaonnext.com/events/example/','name':'Example'}).offers.url,'https://docs.google.com/forms/example')
})
test('requires both date and time, validates dates and handles Nepal midnight',()=>{
  assert.equal(startTime('September 13, 2026 | 7 a.m.'),'2026-09-13T07:00:00+05:45')
  assert.equal(startTime('September 27, 2026 | 11:30 am onwards'),'2026-09-27T11:30:00+05:45')
  assert.equal(startTime('September 27, 2026 | 12 am'),'2026-09-27T00:00:00+05:45')
  for(const s of ['September 27, 2026','Every Tuesday | 4 pm','February 30, 2026 | 4 pm','September 27, 2026 | 13 pm','September 27, 2026 | all day']) assert.equal(startTime(s),null)
})
const raw={url:'https://taragaonnext.com/events/example/',name:'Example',date_text:'September 27, 2026 | 10 am',location:{name:'Taragaon Next'},image:'https://taragaonnext.com/poster.png'}
test('defaults missing and unannounced venues to Taragaon Next in Boudha before publication checks',()=>{
  for(const location of [undefined,{}, {name:''}, {name:'  '}, {name:'Venue to be announced'}, {name:'TBA'}, {name:'Unannounced'}]) {
    const e=transform({...raw,location},{},true,'2026-09-09T00:00:00Z')
    assert.equal(e.venue.name,'Taragaon Next')
    assert.equal(e.venue.city,'Boudha')
    assert.equal(e.status,'published')
    assert.ok(!e.warnings.includes('Venue unannounced'))
  }
  assert.equal(transform({...raw,location:null},{},false,'2026-09-09T00:00:00Z').status,'draft')
  assert.equal(transform({...raw,location:null,image:''},{},true,'2026-09-09T00:00:00Z').status,'draft')
})
test('preserves explicit venues and reviewed overrides',()=>{
  const now='2026-09-09T00:00:00Z'
  assert.equal(transform(raw,{},true,now).venue.name,'Taragaon Next')
  assert.equal(transform({...raw,location:{name:'Chabahil Ganeshthan'}},{},true,now).venue.name,'Chabahil Ganeshthan')
  assert.equal(transform({...raw,location:null},{venue:'Reviewed venue',city:'Patan'},true,now).venue.name,'Reviewed venue')
  assert.equal(transform({...raw,location:null},{venue:'Reviewed venue',city:'Patan'},true,now).venue.city,'Patan')
})
test('strict skip also applies to saved inventories, and past dates',()=>{
  assert.ok(transform({...raw,date_text:''},{starts_at:'2026-09-27T10:00:00+05:45'}).skip)
  assert.ok(transform(raw,{},false,'2026-10-01T00:00:00Z').skip)
})
test('source identity is stable, replay ignores duplicate and matches another source',()=>{
  const e=transform(raw,{},true,'2026-09-09T00:00:00Z')
  assert.equal(e.starts_at,'2026-09-27T04:15:00.000Z')
  assert.equal(e.source_id,'taragaon:example')
  assert.ok(!e.description.includes('katajaam.com'))
  assert.deepEqual(plan([e,e]).map(x=>x.action),['insert','duplicate'])
  assert.equal(plan([e],[{...e,id:'other',url:'https://katajaam.com/events/other',fingerprint:'other',import_source_id:'other'}])[0].action,'duplicate')
})
test('collapses repeated cards, rejects layout changes',()=>{
 const card='<div class="event-item"><h4 class="event-title">Example</h4><p class="event-date">September 27, 2026 | 10 am</p><a class="event-link" href="/events/example/">Read more</a></div>'
 assert.equal(listingPage(card+card).length,1)
 assert.throws(()=>listingPage('<html>Blocked</html>'))
})
