/**
 * Bounded Damerau-Levenshtein distance (#42).
 *
 * Bounded because the only question ever asked of it is "is this within two
 * edits", and answering that does not require computing a distance of nine.
 * The band means a long word compared against a short one costs almost
 * nothing, which matters when a correction pass compares one query token
 * against a few hundred vocabulary entries.
 *
 * Transposition is counted as one edit rather than two, because the single
 * most common phone-keyboard mistake is two adjacent letters swapped —
 * "Kahtmandu" is one slip, not two.
 */
export function withinDistance(a: string, b: string, max: number): number | null {
  if (a === b) return 0
  // Length alone can rule a pair out before a single cell is computed.
  if (Math.abs(a.length - b.length) > max) return null
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length) <= max ? Math.max(a.length, b.length) : null

  let previous = new Array<number>(b.length + 1)
  let current = new Array<number>(b.length + 1)
  let beforePrevious = new Array<number>(b.length + 1)

  for (let j = 0; j <= b.length; j++) previous[j] = j

  for (let i = 1; i <= a.length; i++) {
    const from = Math.max(1, i - max)
    const to = Math.min(b.length, i + max)
    // Cell (i, 0) is "delete the first i characters of a" and costs i. It is
    // in the band only while i is inside the budget — and it must be set
    // before the band is cleared, or every alignment that begins with a
    // deletion is scored a whole edit too high. That is not a rounding error:
    // it made `okathmandu` fail to match `kathmandu` at all.
    current[0] = i <= max ? i : Infinity
    // Cells outside the band can never be part of an accepted path; marking
    // them infinite is what keeps the row honest without computing them.
    for (let j = 1; j < from; j++) current[j] = Infinity
    for (let j = to + 1; j <= b.length; j++) current[j] = Infinity

    let best = Infinity
    for (let j = from; j <= to; j++) {
      const substitution = a[i - 1] === b[j - 1] ? 0 : 1
      let cell = Math.min(
        (previous[j] ?? Infinity) + 1,
        (current[j - 1] ?? Infinity) + 1,
        (previous[j - 1] ?? Infinity) + substitution,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cell = Math.min(cell, (beforePrevious[j - 2] ?? Infinity) + 1)
      }
      current[j] = cell
      if (cell < best) best = cell
    }
    // Every path through this row already costs more than the budget, so no
    // continuation of it can come in under the budget either.
    if (best > max) return null

    const recycled = beforePrevious
    beforePrevious = previous
    previous = current
    current = recycled
  }

  const distance = previous[b.length] ?? Infinity
  return distance <= max ? distance : null
}
