import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import unusedImports from 'eslint-plugin-unused-imports'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

/**
 * Single lint configuration for the whole pnpm workspace. Every area layers on one shared
 * TypeScript base, so "common style" means the same thing in backend, frontend, packages,
 * and ee. Areas add rules; they do not restate the base.
 */

const TEST_FILES = [
  '**/tests/**/*.{ts,tsx}',
  '**/test/**/*.{ts,tsx}',
  '**/*.{test,spec}.{ts,tsx}',
  '**/__tests__/**/*.{ts,tsx}',
  '**/__mocks__/**/*.{ts,tsx}',
  '**/e2e/**/*.{ts,tsx}',
  '**/vitest.config.ts',
  '**/playwright.config.ts',
]

/**
 * Type-aware rules earn their place one at a time. The whole `recommendedTypeChecked` preset
 * is dominated here by `no-unsafe-*` and `require-await`, which fire ~7k times on mock-heavy
 * test code — a gate nobody could keep green and that teaches nothing where it fires.
 */
const TYPE_AWARE_RULES = {
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/no-base-to-string': 'error',
  '@typescript-eslint/no-duplicate-type-constituents': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-redundant-type-constituents': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unsafe-enum-comparison': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    { allowNumber: true, allowBoolean: true },
  ],
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/out/**',
      '**/coverage/**',
      '**/*.d.{ts,mts,cts}',
      '**/*.min.js',
      '**/test-results/**',
      '**/playwright-report/**',
      '.specify/**',
      'infra/**',
      // Static assets, including vendored third-party bundles we do not author.
      '**/public/**',
      // Generated from the committed OpenAPI snapshot by `pnpm run sync`.
      'typescript-sdk/src/generated/**',
      // Generated into the frontend by the EE build.
      'frontend/app/{api/embed,embed,embed-test,radioso-embed.js,operator}/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      ...TYPE_AWARE_RULES,
      // TypeScript resolves identifiers itself; `no-undef` only produces false positives on
      // typed code and needs a globals list it cannot infer.
      'no-undef': 'off',
      // Several input validators deliberately reject C0 control characters, which is what
      // this rule reads as a typo.
      'no-control-regex': 'off',
      // unused-imports separates "delete this import" (a safe autofix) from "this binding is
      // dead" (needs a human), which the built-in rule cannot do.
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    files: ['frontend/**/*.{ts,tsx}', 'docs-portal/**/*.{ts,tsx}'],
    extends: [nextCoreWebVitals, nextTypescript],
    rules: {
      // `onClick={async () => ...}` is how React is written and React handles the promise.
      // The argument checks stay on: those are the cases that really do drop a rejection.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      // Both apps are App Router; this rule looks for a `pages/` directory and only warns
      // that it cannot find one.
      '@next/next/no-html-link-for-pages': 'off',
    },
  },

  {
    files: TEST_FILES,
    rules: {
      // Test doubles are untyped by construction: `any` and unbound method references are
      // what a mock is, not a defect.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/require-await': 'off',
      // Stream doubles are written as `async function*` that yield nothing.
      'require-yield': 'off',
    },
  },

  // Hand-written browser and Node scripts that are not part of a TypeScript project.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
)
