// ESLint 扁平配置。
// - src/**、tests/**、*.config.ts：TypeScript，套用 typescript-eslint 推荐规则
// - scripts/**/*.js：Node 启动器，CommonJS 语法，只做基本解析
// - dist/、node_modules/、playwright 产物目录不检查
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'playwright-report/', 'test-results/'] },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', '*.config.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
    },
  },
);
