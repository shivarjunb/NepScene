#!/usr/bin/env node
/**
 * Emit GitHub PR annotations from tool output (#10).
 *
 * Usage:
 *   npm run typecheck 2>&1 | node scripts/annotate.mjs tsc
 *   node scripts/annotate.mjs eslint eslint-report.json
 *
 * Always exits 0: this reports, it does not judge. The task's own exit code is
 * what fails the build.
 */
import { readFileSync } from 'node:fs'
import { parseTscErrors, parseEslintReport, toWorkflowCommand } from './lib/annotations.mjs'

const [mode, file] = process.argv.slice(2)
const root = process.cwd()

const readStdin = async () => {
  process.stdin.setEncoding('utf8')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return chunks.join('')
}

const annotations =
  mode === 'eslint'
    ? parseEslintReport(JSON.parse(readFileSync(file, 'utf8')))
    : parseTscErrors(await readStdin())

for (const annotation of annotations) console.log(toWorkflowCommand(annotation, root))

if (annotations.length > 0) {
  console.log(`::notice::${annotations.length} ${mode} problem(s) annotated on the diff.`)
}
