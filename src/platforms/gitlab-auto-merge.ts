import { outcomeOf } from "./actions.js";
import type { PullAutoMerge } from "./auto-merge.js";
import { gitlabHeaders, mergeRequestUrl } from "./gitlab-changes.js";
import { platformCall, platformSend } from "./http.js";

// GitLab's "merge when the pipeline succeeds" (auto_merge since 17.x; the
// older name is sent too). A merge request it cannot arm (no pipeline to
// wait on, a status the API refuses) is answered unavailable, so the
// server may wait for it itself.

type MergeRequest = {
  state: "opened" | "closed" | "locked" | "merged";
  sha: string;
  detailed_merge_status?: string;
  merge_when_pipeline_succeeds?: boolean;
};

/** What GitLab answers a merge request it will not arm: not mergeable as it is, or nothing to wait on. */
const UNARMABLE = new Set([405, 406, 422]);

export function gitlabAutoMerge(origin: string): PullAutoMerge {
  const send = (token: string, method: string, url: string, body: unknown) =>
    platformSend<MergeRequest>(url, {
      method,
      headers: { ...gitlabHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = (token: string, fullName: string, number: number) =>
    platformCall<MergeRequest>(mergeRequestUrl(origin, fullName, number), {
      headers: gitlabHeaders(token),
    });
  return {
    async enable(token, fullName, number, merge) {
      const mr = await read(token, fullName, number);
      if (!mr) return null;
      if (mr.state !== "opened") return "refused";
      if (mr.sha !== merge.head) return "head_moved";
      if (mr.detailed_merge_status === "mergeable") return "ready";
      const url = `${mergeRequestUrl(origin, fullName, number)}/merge`;
      const sent = await send(token, "PUT", url, {
        sha: merge.head,
        squash: merge.method === "squash",
        auto_merge: true,
        merge_when_pipeline_succeeds: true,
      });
      if (sent && UNARMABLE.has(sent.status)) return "unavailable";
      return outcomeOf(sent, { 409: "head_moved" });
    },
    async disable(token, fullName, number) {
      const mr = await read(token, fullName, number);
      if (!mr) return null;
      if (!mr.merge_when_pipeline_succeeds) return "done";
      const url = `${mergeRequestUrl(origin, fullName, number)}/cancel_merge_when_pipeline_succeeds`;
      return outcomeOf(await send(token, "POST", url, {}), { 406: "done" });
    },
    async readiness(token, fullName, number) {
      const mr = await read(token, fullName, number);
      if (!mr) return null;
      const state = mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed";
      return { state, head: mr.sha, mergeable: mr.detailed_merge_status === "mergeable" };
    },
  };
}
