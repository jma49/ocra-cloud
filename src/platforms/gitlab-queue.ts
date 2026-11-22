import type { QueueState } from "../shared/index.js";
import { outcomeOf } from "./actions.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";
import type { MergeQueue } from "./queue.js";

// Merge trains are a project setting (GitLab Premium); without them the
// project answers no `merge_trains_enabled` and the merge request is merged directly.

type CarStatus = "idle" | "stale" | "fresh" | "merging" | "merged" | "skip_merged";
type Car = { status: CarStatus; target_branch: string; merge_request: { iid: number } };

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
      if (settings.merge_trains_enabled !== true) return { enabled: false, entry: null };
      const trains = `${project(fullName)}/merge_trains`;
      const read = await get(token, `${trains}/merge_requests/${number}`);
      if (!read || (read.status !== 200 && read.status !== 404)) return null;
      const car = read.status === 200 ? (read.body as Car | null) : null;
      if (!car || car.status === "merged") return { enabled: true, entry: null };
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
      return {
        enabled: true,
        entry: { state: STATE[car.status], position: at >= 0 ? at + 1 : null },
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
      const url = `${mergeRequestUrl(origin, fullName, number)}/cancel_merge_when_pipeline_succeeds`;
      return outcomeOf(await send(token, url, {}));
    },
  };
}
