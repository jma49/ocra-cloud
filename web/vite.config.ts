import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Paths are from the repository root, where the npm scripts run.
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
