import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'target/**', 'packages/contracts/src/generated/**', 'web/dist/**', 'fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': [
        'error',
        { selector: "CallExpression[callee.object.name='console'][callee.property.name='log']", message: 'Use the service logger (pino).' },
      ],
    },
  },
  { files: ['scripts/**', 'packages/contracts/scripts/**'], rules: { 'no-restricted-syntax': 'off' } },
);
