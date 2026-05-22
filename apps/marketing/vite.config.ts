import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Marketing site Vite config. Port 5175 so it doesn't collide with the
 * tenant app (5173) or platform console (5174).
 *
 * The /public proxy points lead-capture and signup forms at the API.
 * Both endpoints are anonymous so they don't need a tenant prefix.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/public": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
