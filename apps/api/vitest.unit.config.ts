import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
export default defineConfig({ plugins: [swc.vite()], test: { environment: 'node', setupFiles: ['test/helpers/no-database.unit-setup.ts'], include: ['test/**/*.unit.test.ts', 'test/env.validation.test.ts', 'test/m1.data.test.ts'], fileParallelism: false } });
