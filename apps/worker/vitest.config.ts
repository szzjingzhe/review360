import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../scripts/test-db-verify.mjs'],
    globals: true,
    fileParallelism: false,
    poolOptions: { threads: { singleThread: true } },
  },
});
