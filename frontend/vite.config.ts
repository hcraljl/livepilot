import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite 配置
 * 契约依据：API.md —— 后端基础地址 http://localhost:4000，前端经代理访问
 * 负责人：A · @since v0.1.0（v0.5.1 增补静态页代理）
 *
 * 为什么 /watch 也要代理（v0.5.1）：
 * 观众端观看页由**后端**托管并做优先级选择——`/watch/` 若存在官方构建产物
 * （frontend/watch-sdk）就托管它，否则回退轻量页（frontend/watch），另有 /watch-lite。
 * 若不代理，dev 下 Vite 会直接命中目录里的轻量页，形成「开发看到兜底页、生产看到官方页」
 * 的 dev/prod 不一致；代理后两侧同源同内容，也避免跨端口的字体/Cookie 问题。
 */
const BACKEND_ORIGIN = 'http://localhost:4000';

/** 由后端托管的静态页（前缀匹配：/watch 同时覆盖 /watch-lite） @since v0.5.1 */
const BACKEND_STATIC_PREFIXES = ['/watch', '/demo'];

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
      // 观看页 / 演示台：交给后端决定用官方产物还是兜底页
      ...Object.fromEntries(
        BACKEND_STATIC_PREFIXES.map((prefix) => [prefix, { target: BACKEND_ORIGIN, changeOrigin: true }]),
      ),
    },
  },
});
