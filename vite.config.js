import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 官方推荐的 vite 配置：
// - 固定端口，避免 Tauri 启动时找不到 devServer
// - 忽略 src-tauri 目录的文件变化，防止 Rust 编译触发前端重载
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
