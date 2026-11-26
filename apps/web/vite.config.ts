import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  build: {
    // 每次构建清空 dist：否则历史产物会堆积，并被打进前端镜像
    emptyOutDir: true,
  },
  server: {
    port: 5373,
    strictPort: true,
    proxy: {
      '/api': process.env.API_PROXY_TARGET || 'http://localhost:3200',
    },
  },
});
