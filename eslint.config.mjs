import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
    },
  },
  {
    // The pricing engine stays pure (NFR-04): no framework, no database, nothing outside its folder.
    files: ['src/modules/pricing-engine/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['@nestjs/*', 'typeorm', 'pg', '../*'] }],
    },
  },
];
