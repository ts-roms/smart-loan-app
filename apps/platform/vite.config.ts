import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Platform console Vite config — intentionally minimal. No PWA, no
 * Tailwind, no fancy plugins. The platform UI is internal-only and
 * we want fast iteration / small bundle / easy deploy.
 *
 * Dev server runs on 5174 so it doesn't collide with the tenant web
 * app (5173). Both proxy /api/v1 → 3001 in dev (same Fastify process
 * serves /api/v1/* and /platform/*).
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/platform": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
