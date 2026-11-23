import { MAX_QUEUE_AHEAD, type QueueState } from "../shared/index.js";
import { outcomeOf } from "./actions.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import type { MergeQueue } from "./queue.js";

// Merge trains are a project setting (GitLab Premium); without them the
// project answers no `merge_trains_enabled` and the merge request is merged directly.

type CarStatus = "idle" | "stale" | "fresh" | "merging" | "merged" | "skip_merged";
type Car = {
  status: CarStatus;
  target_branch: string;
  created_at?: string;
  user?: { username: string } | null;
  merge_request: { iid: number; title?: string };
};

const STATE = {
  idle: "waiting",
  stale: "waiting",
  fresh: "checking",
  merging: "merging",
  skip_merged: "merging",
} as const satisfies Record<Exclude<CarStatus, "merged">, QueueState>;

/** A train's length the position is looked for in: one page. */
const MAX_CARS = 100;

export function gitlabQueue(origin: string): MergeQueue {
  const project = (fullName: string) => `${origin}/api/v4/projects/${encodeURIComponent(fullName)}`;
  const get = (token: string, url: string) =>
    platformSend<unknown>(url, { headers: gitlabHeaders(token) });
  const send = (token: string, url: string, body: unknown) =>
    platformSend(url, {
      method: "POST",
      headers: { ...gitlabHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    async status(token, fullName, number) {
      const settings = await platformCall<{ merge_trains_enabled?: boolean }>(project(fullName), {
        headers: gitlabHeaders(token),
      });
      if (!settings) return null;
      const none = { entry: null, ahead: [], size: null, removed: null };
      if (settings.merge_trains_enabled !== true) return { enabled: false, ...none };
      const trains = `${project(fullName)}/merge_trains`;
      const read = await get(token, `${trains}/merge_requests/${number}`);
      if (!read || (read.status !== 200 && read.status !== 404)) return null;
      const car = read.status === 200 ? (read.body as Car | null) : null;
      if (!car || car.status === "merged") return { enabled: true, ...none };
      const query = new URLSearchParams({
        scope: "active",
        target_branch: car.target_branch,
        sort: "asc",
        per_page: String(MAX_CARS),
      });
      const train = await platformCall<Car[]>(`${trains}?${query}`, {
        headers: gitlabHeaders(token),
      });
      const at = train?.findIndex((c) => c.merge_request.iid === number) ?? -1;
      const ahead = (train ?? []).slice(0, Math.max(at, 0)).filter((c) => c.status !== "merged");
      return {
        enabled: true,
        entry: {
          state: STATE[car.status],
          position: at >= 0 ? at + 1 : null,
          enqueuedAt: car.created_at ?? null,
          enqueuedBy: car.user?.username ?? null,
          estimate: null,
        },
        ahead: ahead.slice(0, MAX_QUEUE_AHEAD).map((c) => ({
          number: c.merge_request.iid,
          title: c.merge_request.title ?? "",
          state: STATE[c.status as Exclude<CarStatus, "merged">],
        })),
        // A full page may not be the whole train.
        size: train && train.length < MAX_CARS ? train.length : null,
        removed: null,
      };
    },
    async enqueue(token, fullName, number, head) {
      const url = `${project(fullName)}/merge_trains/merge_requests/${number}`;
      return outcomeOf(await send(token, url, { sha: head }), {
        400: "not_mergeable",
        409: "head_moved",
      });
    },
    async dequeue(token, fullName, number) {
      const car = await get(token, `${project(fullName)}/merge_trains/merge_requests/${number}`);
      if (car?.status === 404) return "done";
      if (car?.status !== 200) return null;
      const url = `${mergeRequestUrl(origin, fullName, number)}/cancel_merge_when_pipeline_succeeds`;
      return outcomeOf(await send(token, url, {}));
    },
  };
}
