/** Types for the PR annotation parsers. See guards.d.mts for why these exist. */
export interface Annotation {
  file: string
  line: number
  col: number
  level: 'error' | 'warning'
  message: string
}
export declare function parseTscErrors(output: string): Annotation[]
export declare function parseEslintReport(report: unknown): Annotation[]
export declare function toWorkflowCommand(annotation: Annotation, root?: string): string
