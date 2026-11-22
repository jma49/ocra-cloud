import type { PgTable } from "drizzle-orm/pg-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as sqlite from "../schema.js";
import { postgresTable } from "./tables.js";

// The Postgres tables, in ../schema.ts's order (a table after those it
// references), for drizzle-kit (drizzle.pg.config.ts). The test
// test-node/postgres-schema.test.ts fails when one is missing.

const made = new Map<SQLiteTable, PgTable>();
const pg = (table: SQLiteTable) => postgresTable(table, made);

export const accounts = pg(sqlite.accounts);
export const identities = pg(sqlite.identities);
export const sessions = pg(sqlite.sessions);
export const deviceCodes = pg(sqlite.deviceCodes);
export const serviceCounters = pg(sqlite.serviceCounters);
export const rateWindows = pg(sqlite.rateWindows);
export const providerKeys = pg(sqlite.providerKeys);
export const reviews = pg(sqlite.reviews);
export const preferences = pg(sqlite.preferences);
export const auditEvents = pg(sqlite.auditEvents);
export const gatewayCalls = pg(sqlite.gatewayCalls);
export const preferenceVersions = pg(sqlite.preferenceVersions);
export const findings = pg(sqlite.findings);
export const accountMemory = pg(sqlite.accountMemory);
export const usageCounters = pg(sqlite.usageCounters);
export const platformLinks = pg(sqlite.platformLinks);
export const budgets = pg(sqlite.budgets);
export const repositories = pg(sqlite.repositories);
export const pullViews = pg(sqlite.pullViews);
export const graphRepos = pg(sqlite.graphRepos);
export const graphBuilds = pg(sqlite.graphBuilds);
export const reviewRepos = pg(sqlite.reviewRepos);
export const reviewJobs = pg(sqlite.reviewJobs);
export const notifyChannels = pg(sqlite.notifyChannels);
export const replyJobs = pg(sqlite.replyJobs);
