export function schedule(text) {
  const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
  // Require the year alongside the date, never borrow it from copyright or poster URLs.
  const d=text.match(/\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,\s]+(20\d{2})\b/i)
    ?? text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
  const t=text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?\b/i)
  if(!d || !t) return null
  const iso=d[1].length===4
  const year=+(iso?d[1]:d[3]), month=iso?+d[2]:months.indexOf(d[2].slice(0,3).toLowerCase())+1, day=+(iso?d[3]:d[1])
  const hour=+t[1], minute=+(t[2]??0)
  if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour<1||hour>12||minute>59) return null
  const hh=hour%12+(t[3].toUpperCase()==='P'?12:0)
  return new Date(Date.UTC(year,month-1,day,hh,minute)-345*60000).toISOString()
}
