import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The web app's tests run in a simulated browser; the Worker's run in workerd
// (vitest.config.ts).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["web/src/**/*.test.{ts,tsx}"],
  },
});
