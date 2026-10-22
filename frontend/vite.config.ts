import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置
 * 契约依据：API.md —— 后端基础地址 http://localhost:4000，前端经 /api 代理访问
 * 负责人：A · @since v0.1.0
 */
const BACKEND_ORIGIN = 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // REST（/api/state、/api/mode …）与 SSE（/api/stream）统一走此前缀
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
      },
    },
  },
});
