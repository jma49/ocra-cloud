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
export const apiTokens = pg(sqlite.apiTokens);
export const deviceCodes = pg(sqlite.deviceCodes);
export const serviceCounters = pg(sqlite.serviceCounters);
export const rateWindows = pg(sqlite.rateWindows);
export const reviewRunners = pg(sqlite.reviewRunners);
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
export const pullSeen = pg(sqlite.pullSeen);
export const pullFileViews = pg(sqlite.pullFileViews);
export const findingIssues = pg(sqlite.findingIssues);
export const graphRepos = pg(sqlite.graphRepos);
export const graphBuilds = pg(sqlite.graphBuilds);
export const reviewRepos = pg(sqlite.reviewRepos);
export const reviewJobs = pg(sqlite.reviewJobs);
export const notifyChannels = pg(sqlite.notifyChannels);
export const notifySends = pg(sqlite.notifySends);
export const notifyHeld = pg(sqlite.notifyHeld);
export const webhookDeliveries = pg(sqlite.webhookDeliveries);
export const closedPulls = pg(sqlite.closedPulls);
export const pullFlows = pg(sqlite.pullFlows);
export const pullReviews = pg(sqlite.pullReviews);
export const reviewThreads = pg(sqlite.reviewThreads);
export const pullPaths = pg(sqlite.pullPaths);
export const reviewRequests = pg(sqlite.reviewRequests);
export const reviewTargets = pg(sqlite.reviewTargets);
export const replyJobs = pg(sqlite.replyJobs);
export const reviewWalkthroughs = pg(sqlite.reviewWalkthroughs);
export const generateJobs = pg(sqlite.generateJobs);
export const automationRules = pg(sqlite.automationRules);
export const automationRuns = pg(sqlite.automationRuns);
export const automationAssignments = pg(sqlite.automationAssignments);
export const mergeChecks = pg(sqlite.mergeChecks);
export const mergeCheckRuns = pg(sqlite.mergeCheckRuns);
export const mergeIntents = pg(sqlite.mergeIntents);
export const reviewChatMessages = pg(sqlite.reviewChatMessages);
export const liveRuns = pg(sqlite.liveRuns);
export const liveEvents = pg(sqlite.liveEvents);
export const liveGrants = pg(sqlite.liveGrants);
export const liveComments = pg(sqlite.liveComments);
