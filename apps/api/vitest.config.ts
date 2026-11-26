import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  // NestJS 依赖 TS 的 emitDecoratorMetadata（构造器注入类型元数据），
  // esbuild 不支持该选项，必须用 SWC 转换（NestJS 官方推荐的 Vitest 方案）。
  plugins: [swc.vite()],
  test: {
    setupFiles: ['../../scripts/test-db-verify.mjs'],
    environment: 'node',
    globals: true,
    // 集成测试串行执行，避免端口/数据竞争
    fileParallelism: false,
    testTimeout: 30000,
  },
});
