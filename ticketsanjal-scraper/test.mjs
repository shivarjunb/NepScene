import test from 'node:test'
import assert from 'node:assert/strict'
import {schedule} from './schedule.mjs'
import {withArchiveStatus} from './directory.mjs'
test('archive status comes from the API, including learn-more cards',()=>{
 const cards=[{url:'https://ticketsanjal.com/events/1',booking_disabled:null},{url:'https://ticketsanjal.com/events/2',booking_disabled:true}]
 const result=withArchiveStatus(cards,{success:true,data:{data:[{id:2,isExpired:false},{id:1,isExpired:true}]}})
 assert.deepEqual(result.map(c=>c.is_expired),[true,false])
 assert.throws(()=>withArchiveStatus(cards,{success:true,data:{data:[]}}),/Missing archive status/)
})
test('requires year and time',()=>{
 assert.equal(schedule('26 Sep\n8:00 PM Onwards'),null)
 assert.equal(schedule('26 Sep 2026'),null)
 assert.equal(schedule('26 Sep 2026\n8:00 PM Onwards'),'2026-09-26T14:15:00.000Z')
 assert.equal(schedule('2026-09-26\n12:00 AM'),'2026-09-25T18:15:00.000Z')
 assert.equal(schedule('30 Feb 2026 8 PM'),null)
})
