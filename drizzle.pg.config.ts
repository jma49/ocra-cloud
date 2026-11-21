import { defineConfig } from "drizzle-kit";

// The Postgres migrations of a self-hosted server, from the same schema
// (src/db/pg/schema.ts makes its tables from src/db/schema.ts).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/pg/schema.ts",
  out: "./migrations-pg",
});
