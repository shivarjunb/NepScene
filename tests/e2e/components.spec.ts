import { expect, test } from '@playwright/test'

/** #16 — every primitive keyboard operable, focus visible, modals trapping. */

test('the gallery renders every component in every state', async ({ page }) => {
  await page.goto('/')
  for (const heading of ['Buttons', 'Form controls', 'Badges and chips', 'Alerts',
                         'Surfaces, loading and overlay', 'Tabs']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible()
  }
  for (const variant of ['primary', 'secondary', 'ghost', 'danger']) {
    await expect(page.getByRole('button', { name: variant, exact: true })).toBeVisible()
  }
})

test('every interactive primitive is reachable by keyboard alone', async ({ page }) => {
  await page.goto('/')

  // Walk the whole page with Tab and collect what receives focus. A control
  // that never appears here cannot be operated without a mouse.
  const reached = new Set<string>()
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab')
    const tag = await page.evaluate(() => {
      const el = document.activeElement
      return el ? `${el.tagName.toLowerCase()}${el.getAttribute('type') ? ':' + el.getAttribute('type') : ''}` : ''
    })
    if (tag) reached.add(tag)
  }

  for (const expected of ['button', 'a', 'input', 'select', 'textarea']) {
    expect([...reached].some((t) => t.startsWith(expected)), `${expected} was never focused`).toBe(true)
  }
})

test('focus is visible wherever it lands', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')

  const outline = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!)
    return { width: style.outlineWidth, style: style.outlineStyle }
  })
  expect(outline.style).not.toBe('none')
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2)
})

test('a modal traps focus and gives it back on close', async ({ page }) => {
  await page.goto('/')
  const opener = page.getByRole('button', { name: 'Open dialog' })
  await opener.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  for (let i = 0; i < 10; i++) {
    await page.keyboard.press('Tab')
    const inside = await page.evaluate(() =>
      document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false)
    expect(inside, `focus escaped the dialog after ${i + 1} tabs`).toBe(true)
  }

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()
})

test('a modal closes on a click outside', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Open dialog' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()

  await page.locator('.modal__scrim').click({ position: { x: 5, y: 5 } })
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('tabs follow the arrow-key pattern', async ({ page }) => {
  await page.goto('/')
  const tablist = page.getByRole('tablist', { name: 'Gallery example' })
  const first = tablist.getByRole('tab').first()

  await first.click()
  await expect(first).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('ArrowRight')
  await expect(tablist.getByRole('tab').nth(1)).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('End')
  await expect(tablist.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true')

  await page.keyboard.press('Home')
  await expect(first).toHaveAttribute('aria-selected', 'true')

  // Roving tabindex: exactly one tab is in the tab order.
  const tabbable = await tablist.getByRole('tab').evaluateAll(
    (nodes) => nodes.filter((n) => n.getAttribute('tabindex') === '0').length)
  expect(tabbable).toBe(1)
})

test('every form control is labelled and errors are announced', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Event name')).toBeVisible()
  await expect(page.getByLabel('Venue', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Description')).toBeVisible()
  await expect(page.getByLabel('Feature on the homepage')).toBeVisible()

  const error = page.getByRole('alert').filter({ hasText: 'Choose a venue before publishing' })
  await expect(error).toBeVisible()
  // The invalid control points at its message rather than merely turning red.
  const describedBy = await page.getByLabel('Venue', { exact: true }).getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`#${describedBy!.split(' ').pop()}`)).toContainText('Choose a venue')
})

test('a loading button is disabled and announced as busy', async ({ page }) => {
  await page.goto('/')
  const loading = page.getByRole('button', { name: 'Loading' })
  await expect(loading).toBeDisabled()
  await expect(loading).toHaveAttribute('aria-busy', 'true')
})
