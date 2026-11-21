import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { openPglite } from "./pglite.js";

// Each test file's own Postgres, in memory, with the migrations applied:
// what D1 is to the workerd project. int8 and numeric read as numbers, as
// node-postgres is told to (src/node/postgres.ts).
export const db = await openPglite(
  new PGlite({ parsers: { 20: Number, 1700: Number } }),
  resolve("migrations-pg"),
);
