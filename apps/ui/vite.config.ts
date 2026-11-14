import { defineConfig } from "vite";

/**
 * 构建产物直指 ui-server 静态目录（apps/ui-server/dist/public，即 defaultStaticDir）。
 * 依赖 @applift/ui-server（workspace）保证 `pnpm -r build` 中 ui-server 的 tsdown --clean
 * 先跑、本包 vite 后写，避免 dist/public 被清空。
 */
export default defineConfig({
  build: {
    outDir: "../ui-server/dist/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:47600", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:47600", ws: true },
    },
  },
});
