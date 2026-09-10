import { chromium } from 'playwright'
import {mkdirSync,writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {schedule} from './schedule.mjs'
import {readDirectoryCards,waitForDirectoryResponse,withArchiveStatus} from './directory.mjs'
const args=process.argv.slice(2)
if(args.some(a=>a!=='--headed')) throw Error('Usage: node scrape.mjs [--headed]')
const out=resolve('ticketsanjal-output',new Date().toISOString().replace(/[:.]/g,'-'))
mkdirSync(out,{recursive:true})
const report={checked_at:new Date().toISOString(),source:'https://ticketsanjal.com/events',complete:false,listings:[],events:[],skipped:[],errors:[]}
const save=()=>writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2))
const browser=await chromium.launch({headless:!args.includes('--headed')})
try {
 const page=await browser.newPage()
 let [directoryResponse]=await Promise.all([waitForDirectoryResponse(page,1),page.goto(report.source,{waitUntil:'domcontentloaded'})])
 await page.getByRole('heading',{name:/Found \d+ events/}).waitFor({timeout:60000})
 let expected
 const seen=new Map(), signatures=new Set()
 let previous=''
 for(let n=0;n<100;n++) {
  const cards=withArchiveStatus(await readDirectoryCards(page,previous),await directoryResponse.json())
  if(expected===undefined) expected=Number((await page.getByRole('heading',{name:/Found \d+ events/}).innerText()).match(/\d+/)[0])
  const signature=cards.map(c=>c.url).join('|')
  if(signatures.has(signature)) throw Error('Pagination repeated a page')
  signatures.add(signature)
  cards.forEach(c=>seen.set(c.url,c))
  console.log(`Directory: ${seen.size}/${expected}`)
  const next=page.getByRole('button',{name:'next page',exact:true})
  if(await next.isDisabled()) break
  previous=signature
  ;[directoryResponse]=await Promise.all([waitForDirectoryResponse(page,n+2),next.click()])
 }
 report.listings=[...seen.values()]
 if(seen.size!==expected) throw Error(`Incomplete directory: ${seen.size}/${expected}`)
 const active=report.listings.filter(card=>!card.is_expired)
 report.skipped.push(...report.listings.filter(card=>card.is_expired).map(card=>({...card,source_id:'ticketsanjal:'+card.url.split('/').at(-1),reason:'Archived event (directory isExpired)'})))
 console.log(`Archived: ${report.skipped.length}; details to fetch: ${active.length}`)
 save()
 for(const [i,card] of active.entries()) {
  console.log(`Details ${i+1}/${active.length}: ${card.title}`)
  try {
   await page.goto(card.url,{waitUntil:'domcontentloaded'})
   await page.getByRole('heading',{name:'Event Details',exact:true}).waitFor({timeout:30000})
   const body=await page.locator('body').innerText()
   // Restrict date extraction to the actual schedule before the description.
   const header=body.split('Event Details')[0]
   const start=header.indexOf(card.title)
   const scheduleText=start<0?'':header.slice(start+card.title.length)
   const starts_at=schedule(scheduleText)
   const description=body.split('Event Details')[1]?.split('Terms & Conditions')[0]?.split('Similar Events')[0]?.trim()??''
   const organizer=await page.locator('a[href^="/organizer/"]').first().textContent().catch(()=>null)
   const price=card.card_text.match(/Rs\.\s*([\d,]+(?:\.\d+)?)/)?.[1]
   const e={...card,source_id:'ticketsanjal:'+card.url.split('/').at(-1),starts_at,timezone:'Asia/Kathmandu',schedule_text:scheduleText,description,organizer:organizer?.trim()??null,price_npr:price?Number(price.replaceAll(',','')):null}
   const reason=!starts_at?'Missing or unsupported explicit year/date/time':Date.parse(starts_at)<Date.now()?'Past start date/time':null
   if(reason) report.skipped.push({...e,reason}); else report.events.push(e)
  } catch(error) {report.errors.push({url:card.url,error:error.message})}
  save()
  await new Promise(r=>setTimeout(r,500))
 }
 report.complete=report.errors.length===0
 save()
 console.log(`Eligible: ${report.events.length}; skipped: ${report.skipped.length}; errors: ${report.errors.length}. Report: ${out}`)
 if(!report.complete) process.exitCode=1
} catch(error) {report.errors.push({error:error.message});save();throw error}
finally {await browser.close()}
