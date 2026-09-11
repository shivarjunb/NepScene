#!/usr/bin/env node
/**
 * Every caught error is either rethrown or counted (#50).
 *
 * The rule, and why it is a build failure rather than a code-review habit, is
 * documented on `silentCatches` in scripts/lib/guards.mjs. The short version:
 * an error that is caught and not reported is worse than one that crashes,
 * because it removes the signal without removing the problem — and a
 * convention against it lasts until the first tired afternoon.
 *
 * Unlike the scope guard, this **fails** rather than warning. A commerce term
 * might be a false positive worth a human look; a silent catch is either a bug
 * or a one-line `// swallow-guard:allow` with a reason, and both are the
 * author's to resolve before merge.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { silentCatches } from './lib/guards.mjs'

const ROOT = 'api'

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (path.endsWith('.ts')) yield path
  }
}

if (!existsSync(ROOT)) {
  console.log('::notice::No api/ directory yet — silent-catch guard idle.')
  process.exit(0)
}

const hits = []
for (const file of walk(ROOT)) {
  hits.push(...silentCatches(readFileSync(file, 'utf8'), file))
}

if (hits.length === 0) {
  console.log(`No silent catches in ${ROOT}/.`)
  process.exit(0)
}

console.error(`${hits.length} catch block(s) neither rethrow nor report:`)
for (const hit of hits) {
  console.error(`::error file=${hit.file},line=${hit.line}::Silent catch — call swallowed() or rethrow`)
  console.error(`  ${hit.file}:${hit.line}  ${hit.text}`)
}
console.error(
  '\nSwallowing is often right. Doing it silently never is: call'
  + '\n`swallowed(reason, cause)` from api/lib/observability.ts so the rate is'
  + '\ncountable, or add `// swallow-guard:allow` with a reason if the caught'
  + '\nerror is genuinely this code\'s output.',
)
process.exit(1)
