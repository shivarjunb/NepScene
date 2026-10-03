import { expect, test, type Browser, type Page } from '@playwright/test'
import { serveMapCatalog, stubMapsSdk } from './mapStub'
import { DARK_MAP_BACKGROUND, DARK_MAP_STYLES } from '../../app/map/mapStyles'

/**
 * The map follows the site's theme (app/map/mapStyles.ts, useMapTheme.ts).
 *
 * The stub draws no tiles, so what is asserted is what the map was *told*:
 * the options it was built with and every `setOptions` after. Whether Google
 * paints them is Google's business; that the app hands it the right ones, at
 * the right moments, and to the same map rather than a rebuilt one, is ours.
 */

type Options = { styles?: unknown; backgroundColor?: string }

const sdkOptions = (page: Page) => page.evaluate(() => (
  window as unknown as { google: { maps: { __options: () => {
    built: Options; updates: Options[]
  } } } }
).google.maps.__options())

/** What the map holds now: its build options with every later change laid over them. */
async function current(page: Page): Promise<Options> {
  const { built, updates } = await sdkOptions(page)
  return Object.assign({}, built, ...updates)
}

const isDark = async (page: Page) => {
  const { styles, backgroundColor } = await current(page)
  return JSON.stringify(styles) === JSON.stringify(DARK_MAP_STYLES)
    && backgroundColor === DARK_MAP_BACKGROUND
}

async function openMap(page: Page) {
  await stubMapsSdk(page)
  await serveMapCatalog(page)
  await page.goto('/map')
  await expect(page.getByText(/3 listings in view/)).toBeVisible()
}

async function mapIn(browser: Browser, colorScheme: 'light' | 'dark', stored?: string) {
  const context = await browser.newContext({ colorScheme })
  if (stored) await context.addInitScript((value) => localStorage.setItem('nepscene-theme', value), stored)
  const page = await context.newPage()
  await openMap(page)
  return { page, close: () => context.close() }
}

const chooseTheme = (page: Page, name: 'Light' | 'Dark' | 'System') =>
  page.getByRole('group', { name: 'Colour theme' }).getByRole('button', { name }).click()

test('a dark system preference builds the map dark, on the page’s own ground', async ({ browser }) => {
  const { page, close } = await mapIn(browser, 'dark')

  const { built, updates } = await sdkOptions(page)
  expect(built.styles).toEqual(DARK_MAP_STYLES)
  // The ground under the tiles is the page's: no white flash while they load,
  // and no seam where the map meets the page around it.
  const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  expect(ground).toBe('rgb(20, 28, 56)')
  expect(built.backgroundColor).toBe(DARK_MAP_BACKGROUND)
  expect(DARK_MAP_BACKGROUND).toBe('#141c38')
  // Built right the first time, so it is not restyled again on arrival.
  expect(updates).toEqual([])

  await close()
})

test('a light system preference leaves the map Google’s own', async ({ browser }) => {
  const { page, close } = await mapIn(browser, 'light')

  const { built, updates } = await sdkOptions(page)
  expect(built.styles).toBeNull()
  expect(built.backgroundColor).not.toBe(DARK_MAP_BACKGROUND)
  expect(updates).toEqual([])

  await close()
})

test('an explicit choice beats the OS for the map, as it does for the page', async ({ browser }) => {
  const { page, close } = await mapIn(browser, 'dark', 'light')
  expect((await sdkOptions(page)).built.styles).toBeNull()
  await close()
})

test('switching the site theme restyles the open map, both ways', async ({ browser }) => {
  const { page, close } = await mapIn(browser, 'light')

  await chooseTheme(page, 'Dark')
  await expect.poll(() => isDark(page)).toBe(true)

  await chooseTheme(page, 'Light')
  await expect.poll(async () => (await current(page)).styles).toBeNull()

  // Restyled in place — a rebuilt map would lose the viewer's pan and pins,
  // and Google bills every map it constructs.
  const { updates } = await sdkOptions(page)
  expect(updates).toHaveLength(2)
  expect(await page.evaluate(() => (
    window as unknown as { google: { maps: { __markerCount: () => number } } }
  ).google.maps.__markerCount())).toBe(2)

  await close()
})

test('while the theme is System, the OS changing restyles the open map', async ({ browser }) => {
  const { page, close } = await mapIn(browser, 'light')

  await page.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => isDark(page)).toBe(true)

  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(async () => (await current(page)).styles).toBeNull()

  // And an explicit choice stops it following: the OS going dark again does
  // nothing to a map the visitor asked to keep light.
  await chooseTheme(page, 'Light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(250)
  expect((await current(page)).styles).toBeNull()

  await close()
})
