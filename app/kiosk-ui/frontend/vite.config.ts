import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// KIOSK_API_TARGET overrides the dev-server backend so we can preview the
// UI on the host while talking to the live kiosk's backend over the LAN —
// e.g. `KIOSK_API_TARGET=http://alarm-alpaca.local:8090 \
//        KIOSK_API_AUTH=admin:hunter2 npm run dev`.
// Default keeps the original "local backend on 8090" workflow intact.
const apiTarget = process.env.KIOSK_API_TARGET ?? "http://localhost:8090";
const apiAuth = process.env.KIOSK_API_AUTH;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // Backend default port matches kiosk-ui.nix services.alarm-kiosk.port.
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        auth: apiAuth,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
