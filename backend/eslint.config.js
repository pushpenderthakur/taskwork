/**
 * ESLint flat config for the API.
 *
 * Node globals only (no browser), ESM source. Unused parameters are allowed when
 * prefixed with `_`, which matches the Express handler signatures
 * (`(_req, res)`) and keeps `no-unused-vars` focused on real mistakes.
 */
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['node_modules', '.data', 'coverage']),
  {
    files: ['**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
]);