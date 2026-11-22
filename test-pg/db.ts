import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { openPglite } from "./pglite.js";

// The worker's Postgres, in memory, emptied and migrated again before each
// test file (./fresh.ts): what D1 is to the workerd project. int8 and
// numeric read as numbers, as node-postgres is told to
// (src/node/postgres.ts).
export const { db, reset } = await openPglite(
  new PGlite({ parsers: { 20: Number, 1700: Number } }),
  resolve("migrations-pg"),
);
