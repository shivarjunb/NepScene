/**
 * Talking to D1 from a Node script.
 *
 * The importers and the CI guards both shell out to `wrangler d1 execute
 * --json` and both have to refuse a statement that failed. Two copies of that
 * refusal is one copy too many: the guard that checks for schema drift is only
 * worth having if it treats a failed introspection query as a failure rather
 * than as an empty schema.
 */
import { execFileSync } from 'node:child_process'

export function runWrangler(args, config, execute = execFileSync) {
  try {
    return execute(process.execPath, args, config)
  } catch (error) {
    const details = [error.stdout, error.stderr]
      .map((value) => value?.toString().trim()).filter(Boolean).join('\n')
    throw new Error(`Wrangler D1 command failed (exit ${error.status ?? 'unknown'}).${details ? `\n${details}` : `\n${error.message}`}`, { cause: error })
  }
}

export function parseD1Output(output) {
  // Remote file imports can print progress lines even with --json.
  const text = output.trim()
  let result
  for (const match of text.matchAll(/^[\t ]*(?=[[{])/gm)) {
    try { result = JSON.parse(text.slice(match.index)); break } catch { /* Try the next JSON boundary. */ }
  }
  if (result === undefined) throw Error('Wrangler did not return a valid D1 JSON result')
  if (!Array.isArray(result) || !result.length || result.some((x) => !x || x.success !== true || x.error)) {
    throw Error(`D1 reported an unsuccessful statement: ${JSON.stringify(result)}`)
  }
  return result.flatMap((x) => x.results ?? [])
}
