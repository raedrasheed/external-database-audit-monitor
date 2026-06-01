// EDAM lint configuration (Epic E6 / mandate E). Flat config, typescript-eslint
// recommended (non-type-checked for speed). Rules are tuned to enforce real
// hygiene without forcing churn on the existing, reviewed code.

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/*.d.ts'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The contracts/builder layers legitimately handle `unknown`/dynamic JSON.
      '@typescript-eslint/no-explicit-any': 'off',
      // Allow intentionally-unused args/vars prefixed with `_`.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Console is only allowed in entrypoints/alarm sinks via explicit
      // disable directives (which this rule makes meaningful).
      'no-console': 'warn',
    },
  },
  {
    // Tests and scripts may use more permissive patterns.
    files: ['**/test/**/*.ts', '**/scripts/**/*.ts', 'tools/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off', // CLIs / tests legitimately use the console
    },
  },
);
