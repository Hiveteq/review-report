// @ts-check
// Lint rules for the JavaScript files that the lint script in package.json lists.
// The style rules are the "modern JavaScript" baseline: no var, const by default, arrow callbacks,
// template literals. A rule that would force worse code is turned off on that line with a reason,
// never here.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['skills/review-report/reference/'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'object-shorthand': 'error',
      'prefer-spread': 'error',
      'prefer-rest-params': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // The page script runs in the browser as one classic script, inlined into every report.
    files: ['skills/review-report/template/report.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser } },
  },
];
