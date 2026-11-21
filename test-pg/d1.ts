import { db } from "./db.js";

// drizzle-orm/d1 in the Postgres project: whatever D1 binding the code
// opens, the test file's Postgres.
export function drizzle(_binding: unknown) {
  return db;
}
