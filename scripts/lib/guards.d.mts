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
export interface CredentialHit {
  file: string
  line: number
  /** What matched: a credential format, or the name it was assigned to. */
  kind: string
  text: string
}
export declare function credentialHits(text: string, file: string): CredentialHit[]
export interface SchemaObject {
  kind: 'table' | 'index' | 'column'
  name: string
  /** The table the object lives on; equal to `name` for a table. */
  table: string
}
export declare function migrationCreates(sql: string): SchemaObject[]
export interface LiveSchema {
  tables: string[]
  indexes: string[]
  /** Table name → column names. */
  columns: Record<string, string[]>
}
export interface DriftConflict extends SchemaObject {
  /** The pending migration file that would recreate this object. */
  migration: string
}
export declare function schemaDrift(
  pending: { name: string; sql: string }[],
  live: LiveSchema,
): DriftConflict[]
