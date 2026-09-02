import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * The module boundary from docs/ARCHITECTURE.md, enforced rather than trusted.
 *
 * One deployable, three modules: `catalog` reads, `author` writes, `identity`
 * knows who you are. WaahTickets' 7,011-line route file did not start large —
 * it grew because nothing stopped it. These rules are what stops it.
 */
const boundary = (module, restricted) => ({
  files: [`api/${module}/**/*.ts`],
  rules: {
    'no-restricted-imports': ['error', { patterns: restricted }],
  },
})

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.wrangler/**', 'coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // tests assert on untyped JSON
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_',
      }],
    },
  },

  // catalog is the read path: it may not know that authoring or accounts exist.
  boundary('catalog', [
    { group: ['**/author/**'], message: 'catalog must not import author — see docs/ARCHITECTURE.md' },
    { group: ['**/identity/**'], message: 'catalog is anonymous by design and must not import identity' },
  ]),

  // identity is a leaf: it knows about sessions and roles, nothing about the domain.
  boundary('identity', [
    { group: ['**/catalog/**'], message: 'identity must not import catalog' },
    { group: ['**/author/**'], message: 'identity must not import author' },
  ]),

  // author may use identity's public surface (middleware, roles) but not reach
  // into its internals — sessions and password handling are identity's alone.
  boundary('author', [
    { group: ['**/identity/sessions*'], message: 'author must not touch identity internals; use middleware' },
    { group: ['**/identity/password*'], message: 'author must not touch identity internals' },
    { group: ['**/identity/routes*'], message: 'author must not import identity routes' },
  ]),

  {
    files: ['tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    rules: { 'no-restricted-imports': 'off' },
  },

  // Build and seed scripts run in Node, not in the Worker runtime.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
    rules: { 'no-restricted-imports': 'off' },
  },
)
