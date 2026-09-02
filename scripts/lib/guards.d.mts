/**
 * Types for the CI guards. The implementation is plain ESM so CI can run it
 * with node and no build step; this file is what makes it callable from the
 * TypeScript tests that cover it.
 */
export declare function duplicateMigrationPrefixes(filenames: string[]): string[]
export declare function missingMigrationNumbers(filenames: string[]): number[]
export declare const COMMERCE_TERMS: string[]
export interface CommerceHit {
  file: string
  line: number
  term: string
  text: string
}
export declare function commerceHits(text: string, file: string): CommerceHit[]
