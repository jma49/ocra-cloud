import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Paths are from the repository root, where the npm scripts run.
  root: "web",
  plugins: [react()],
  // Nothing inlined as a data: URL: the CSP allows fonts and images from
  // 'self' only (public/_headers), so an inlined font is blocked.
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
