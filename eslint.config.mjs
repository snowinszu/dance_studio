// ESLint 扁平配置。
// - src/**/*.ts：Electron 主进程 / preload，套用 typescript-eslint 推荐规则
// - scripts/**/*.js：Node 启动器，CommonJS 语法，只做基本解析
// - dist/ 与 node_modules/ 不检查
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
  {
    files: ['src/**/*.ts'],
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
