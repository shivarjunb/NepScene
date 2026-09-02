#!/usr/bin/env node
/**
 * Brand asset rasteriser (#19).
 *
 * The mark is authored once as SVG; the PNGs every platform still insists on
 * are rendered from it with the browser Playwright already provides, rather
 * than hand-exported and drifting from the source.
 *
 * Facebook and WhatsApp will not render an SVG og:image, which is the whole
 * reason this script exists.
 *
 *   node scripts/generate-brand-assets.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public', 'brand')
mkdirSync(out, { recursive: true })

const CRIMSON = '#c1121f'
const INK = '#0f172a'

const mark = (size, radius) => `
  <svg width="${size}" height="${size}" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="${radius}" fill="${CRIMSON}"/>
    <path d="M6.4 22.6 12.4 12l3.9 6 3-4.2 6.3 8.8H6.4Z" fill="#ffffff"/>
    <circle cx="10.6" cy="8.9" r="2.1" fill="#ffffff"/>
  </svg>`

const page = (body, extra = '') => `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=Manrope:wght@500&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Manrope',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
  ${extra}
</style></head><body>${body}</body></html>`

const OG_CARD = page(`
  <div class="card">
    <div class="brand">${mark(96, 20)}<span class="word">Nep<span class="accent">Scene</span></span></div>
    <h1>What&rsquo;s happening<br/>around Nepal.</h1>
    <p>Concerts &middot; Festivals &middot; Sports &middot; Comedy &middot; Food &middot; Community</p>
    <div class="rule"></div>
  </div>`, `
  body{width:1200px;height:630px;background:${INK};color:#f8fafc}
  .card{height:100%;padding:80px;display:flex;flex-direction:column;justify-content:center;gap:28px;position:relative;overflow:hidden}
  .card::after{content:'';position:absolute;right:-160px;top:-160px;width:620px;height:620px;border-radius:50%;background:radial-gradient(circle,rgba(193,18,31,.42),transparent 68%)}
  .brand{display:flex;align-items:center;gap:22px;position:relative;z-index:1}
  .word{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:56px;letter-spacing:-.02em}
  .accent{color:#f0808a}
  h1{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:82px;line-height:1.08;letter-spacing:-.03em;position:relative;z-index:1}
  p{font-size:27px;color:#cbd5e1;position:relative;z-index:1}
  .rule{width:132px;height:8px;border-radius:99px;background:${CRIMSON};position:relative;z-index:1}`)

const ICON = (size) => page(`<div class="wrap">${mark(size, 7)}</div>`,
  `body{width:${size}px;height:${size}px}.wrap{width:${size}px;height:${size}px}`)

const browser = await chromium.launch()

async function shot(html, width, height, file, scale = 1) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale,
  })
  const tab = await context.newPage()
  await tab.setContent(html, { waitUntil: 'networkidle' })
  writeFileSync(join(out, file), await tab.screenshot({ type: 'png' }))
  await context.close()
  console.log(`  ${file}  ${width * scale}x${height * scale}`)
}

console.log('Rendering brand assets:')
await shot(OG_CARD, 1200, 630, 'og-card.png')
await shot(ICON(180), 180, 180, 'icon-180.png')
await shot(ICON(512), 512, 512, 'icon-512.png')
await shot(ICON(32), 32, 32, 'favicon-32.png')
// The favicon at its worst case: legibility at 16px is the criterion.
await shot(ICON(16), 16, 16, 'favicon-16.png')

await browser.close()
console.log('Done. favicon.svg is authored by hand and is the source for all of these.')
