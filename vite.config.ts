import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Vite config for the Tauri-targeted renderer build.
//
// Coexists with electron-vite.config.ts during the Electron->Tauri migration:
//   - electron-vite.config.ts: still used by `npm run dev:electron` until the
//     Electron path is retired in Phase 1d.
//   - vite.config.ts (this file): used by `npm run tauri dev` and `tauri build`.
//
// The renderer source still lives at src/renderer/. This config promotes it
// to the project root so Tauri's frontendDist (`../dist`) resolves correctly.
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  publicDir: resolve(__dirname, "src/renderer/public"),
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
});
