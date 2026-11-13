/**
 * ESLint flat config.
 *
 * Combines the JS and React recommended rules with the hooks and Fast Refresh
 * plugins. The React plugin is also what teaches `no-unused-vars` about JSX,
 * which eslint-scope alone gets wrong on React 19.
 */
import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output is generated, not source.
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      react.configs.flat.recommended,
      react.configs.flat['jsx-runtime'],
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // Picks the React version from node_modules so JSX rules behave correctly.
    settings: { react: { version: 'detect' } },
    rules: {
      // This project is plain JSX without runtime prop validation.
      'react/prop-types': 'off',
    },
  },
])
