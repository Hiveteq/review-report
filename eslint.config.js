// @ts-check
// Lint rules for the JavaScript files that the lint script in package.json lists.
// Two groups: the modern-syntax baseline (no var, const by default, arrow callbacks, template literals) and
// structure limits that keep functions small and flat. A rule that would force worse code is turned off on that
// line with `-- reason`. File-level exceptions sit at the end of this list, each with its reason.
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig } from 'eslint/config';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { jsdoc } from 'eslint-plugin-jsdoc';

const FOR_EACH = {
  selector: "CallExpression[callee.property.name='forEach']",
  message: 'Use map/filter/flatMap for transformations, or for…of for side effects.',
};

export default defineConfig([
  { ignores: ['skills/review-report/reference/'] },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' },
  },
  js.configs.recommended,
  comments.recommended,
  jsdoc({ config: 'flat/recommended-typescript-flavor-error' }),
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // The page script runs in the browser as one classic script, inlined into every report.
    files: ['skills/review-report/template/report.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    rules: {
      // Modern syntax
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'object-shorthand': 'error',
      'prefer-spread': 'error',
      'prefer-rest-params': 'error',
      'prefer-object-has-own': 'error',
      'logical-assignment-operators': ['error', 'always', { enforceForIfStatements: true }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // Structure: small, flat functions
      complexity: ['error', 10],
      'max-depth': ['error', 3],
      'max-params': ['error', 3],
      'max-nested-callbacks': ['error', 3],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],

      // Control flow and clarity
      'no-else-return': ['error', { allowElseIf: false }],
      'no-lonely-if': 'error',
      'no-nested-ternary': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'consistent-return': 'error',
      'array-callback-return': ['error', { allowImplicit: true }],
      'default-param-last': 'error',
      'no-param-reassign': ['error', { props: true }],
      'no-return-assign': 'error',
      'no-sequences': 'error',

      // Correctness
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-implicit-coercion': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'no-promise-executor-return': 'error',
      'no-throw-literal': 'error',
      'prefer-promise-reject-errors': 'error',

      // Nothing useless
      'no-useless-return': 'error',
      'no-useless-concat': 'error',
      'no-useless-call': 'error',
      'no-useless-rename': 'error',
      'no-useless-computed-key': 'error',
      'no-useless-constructor': 'error',

      // No forEach: map/filter/flatMap for transformations, for…of for effects
      'no-restricted-syntax': ['error', FOR_EACH],

      // JSDoc: every exported function is documented and every documented function is typed; tsc checks the
      // types. Prose descriptions are not required: a description that repeats the parameter name is noise.
      // Write one where it says something the name and type do not.
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-property-description': 'off',
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: true,
        enableFixer: false,
        require: { FunctionDeclaration: true, ArrowFunctionExpression: true, FunctionExpression: true },
      }],

      // Every disable says why
      '@eslint-community/eslint-comments/require-description': 'error',
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },
  {
    // The page script changes the DOM elements it is handed; that is its job. The parameter itself is still never
    // reassigned, and extra data never goes onto an element as an expando property: use a WeakMap.
    files: ['skills/review-report/template/report.js'],
    rules: {
      'no-param-reassign': ['error', { props: false }],
      'no-restricted-syntax': ['error', FOR_EACH, {
        selector: "AssignmentExpression > MemberExpression.left[property.name=/^_/]",
        message: 'Keep per-element data in a WeakMap, not in an expando property.',
      }],
    },
  },
]);
