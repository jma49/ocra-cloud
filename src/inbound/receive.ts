import type { Context } from "hono";
import type { ReviewedPull } from "../auto-review/paths.js";
import {
  forgetInbound,
  type InboundPlatform,
  rearmInbound,
  receiveInbound,
} from "../db/inbound-events.js";
import { defer } from "../defer.js";
import type { AppEnv } from "../types.js";
import { INBOUND_LEASE_MS, type InboundRunner, type InboundWork, runInbound } from "./run.js";

// A proved delivery is recorded before anything acts on it: a redelivery of
// one recorded finds its row and does nothing. What the answer does itself
// runs next; if it throws, the row goes, so that the platform's redelivery
// is taken. Then the side effects run after the answer, from the row's work
// (./run.ts), which the sweep tries again when they fail.

/** The platforms' ids of a delivery: GitHub's GUID, GitLab's UUID. */
const DELIVERY_ID = /^[A-Za-z0-9-]{8,100}$/;

const runnerOf = (c: Context<AppEnv>): InboundRunner => ({
  db: c.var.db,
  env: c.env,
  bots: c.var.bots,
  mailer: c.var.mailer,
  webhookPost: c.var.webhookPost,
});

/** The origin a delivery's notices link to: PUBLIC_URL's where it is set. */
const originOf = (c: Context<AppEnv>) => new URL(c.env.PUBLIC_URL || c.req.url).origin;

export type Delivery = {
  platform: InboundPlatform;
  host: string;
  /** The platform's id of it; one that is missing or malformed is taken as a new delivery. */
  deliveryId: string | undefined;
  event: string;
  repo: string;
  work: Omit<InboundWork, "origin">;
};

export type Received = {
  /** Adds reading the reviewed pull request's directories to the work. */
  reviewed(pull: ReviewedPull | null): void;
  /** Runs what the answer does; the row goes if it throws. */
  answer<T>(run: () => Promise<T>): Promise<T>;
  /** Keeps the work and runs it after the answer. */
  start(): Promise<void>;
};

/** Records the delivery; null when it was recorded before. */
export async function receive(c: Context<AppEnv>, d: Delivery): Promise<Received | null> {
  const id = crypto.randomUUID();
  const deliveryId = d.deliveryId && DELIVERY_ID.test(d.deliveryId) ? d.deliveryId : id;
  const work: InboundWork = { ...d.work, origin: originOf(c) };
  const db = c.var.db;
  const lease = () => new Date(Date.now() + INBOUND_LEASE_MS);
  const fresh = await receiveInbound(db, {
    id,
    platform: d.platform,
    host: d.host,
    deliveryId,
    event: d.event,
    repo: d.repo,
    work: work.steps.length > 0 ? work : null,
    leaseUntil: lease(),
  });
  if (!fresh) return null;
  let changed = false;
  return {
    reviewed(pull) {
      if (!pull) return;
      work.reviewed = { number: pull.number, head: pull.head };
      work.steps = [...work.steps, "paths"];
      changed = true;
    },
    async answer(run) {
      try {
        return await run();
      } catch (e) {
        await forgetInbound(db, id).catch(() => {});
        throw e;
      }
    },
    async start() {
      if (changed) await rearmInbound(db, id, work, lease());
      if (work.steps.length === 0) return;
      const row = { id, ...d, attempts: 1, work };
      defer(c, runInbound(runnerOf(c), row));
    },
  };
}
