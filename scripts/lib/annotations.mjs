/**
 * Turning tool output into GitHub PR annotations (#10).
 *
 * Without this, a type error is a line in a log someone has to go and open.
 * With it, the error lands on the offending line in the diff. Parsing lives
 * here as pure functions so the formats are covered by tests — both tools
 * change their output between majors.
 */

/** `path/to/file.ts(12,5): error TS2345: Argument of type ...` */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/

/**
 * @param {string} output raw `tsc --pretty false` output
 * @returns {{file: string, line: number, col: number, level: string, message: string}[]}
 */
export function parseTscErrors(output) {
  const annotations = []
  for (const raw of output.split('\n')) {
    const match = TSC_LINE.exec(raw.trim())
    if (!match) continue
    const [, file, line, col, level, code, message] = match
    annotations.push({
      file,
      line: Number(line),
      col: Number(col),
      level: level === 'error' ? 'error' : 'warning',
      message: `${code}: ${message}`,
    })
  }
  return annotations
}

/**
 * @param {unknown} report parsed `eslint -f json` output
 * @returns {{file: string, line: number, col: number, level: string, message: string}[]}
 */
export function parseEslintReport(report) {
  if (!Array.isArray(report)) return []
  const annotations = []
  for (const result of report) {
    for (const m of result.messages ?? []) {
      annotations.push({
        file: result.filePath,
        line: m.line ?? 1,
        col: m.column ?? 1,
        level: m.severity === 2 ? 'error' : 'warning',
        message: m.ruleId ? `${m.message} (${m.ruleId})` : m.message,
      })
    }
  }
  return annotations
}

/**
 * Workflow-command form. Paths must be repo-relative or GitHub silently drops
 * the annotation instead of reporting that it could not place it.
 *
 * @param {{file: string, line: number, col: number, level: string, message: string}} a
 * @param {string} root absolute path to strip
 */
export function toWorkflowCommand(a, root = '') {
  const file = root && a.file.startsWith(root) ? a.file.slice(root.length).replace(/^\//, '') : a.file
  // Newlines and carriage returns terminate a workflow command; they must be escaped.
  const message = a.message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  return `::${a.level} file=${file},line=${a.line},col=${a.col}::${message}`
}
