import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const DEV_PORT = 5173;
// wrangler dev's default port; the Worker owns /health and /api/*.
const WORKER_DEV_ORIGIN = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: DEV_PORT,
    strictPort: true,
    proxy: {
      "/health": WORKER_DEV_ORIGIN,
      "/api": {
        target: WORKER_DEV_ORIGIN,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // dist/ is uploaded verbatim as public Worker assets; don't publish maps.
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
