import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
// @ts-ignore — vitest augments defineConfig when imported from vitest/config
/// <reference types="vitest" />

const host = process.env.TAURI_DEV_HOST;

// `vite build --mode web`: the same interface, built for the noema.tools page.
// `platform.web.ts` takes the place of `platform.ts`, so nothing from Tauri enters the bundle
// (checked by scripts/check-web-bundle.mjs on the finished bundle, not on the source).
// The page lives in the Noema area of the site: the static files in wwwroot/noema/pragma-live/.
const WEB_BASE = "/noema/pragma-live/";

export default defineConfig(({ mode }) => {
  const web = mode === "web";
  return {
  plugins: [vue()],
  base: web ? WEB_BASE : "/",
  resolve: web
    ? {
        alias: [
          {
            find: /^(?:\.{1,2}\/)+platform$/,
            replacement: fileURLToPath(new URL("./src/platform.web.ts", import.meta.url)),
          },
        ],
      }
    : undefined,
  build: web ? { outDir: "dist-web", emptyOutDir: true } : undefined,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  };
});
