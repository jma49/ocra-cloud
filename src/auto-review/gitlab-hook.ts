import { platformJson, platformSend } from "../platforms/http.js";

// The project hook ocra's GitLab reviews arrive through (./webhooks.ts),
// added or brought up to date with a token that may manage the project's
// hooks: GitLab asks for the Maintainer role.

/** The hooks ./webhooks.ts reads: merge requests, comments and pipelines. */
const EVENTS = {
  merge_requests_events: true,
  note_events: true,
  pipeline_events: true,
  push_events: false,
};

/** One page: a project with more hooks than this is looked for by the id ocra kept. */
const PAGE = 100;
const MAX_LIST_BYTES = 512 * 1024;

export type HookTarget = {
  /** The instance's address (src/platforms/registry.ts), without a trailing slash. */
  instance: string;
  projectId: string;
  token: string;
};

export type HookResult =
  | { ok: true; id: string }
  | { ok: false; reason: "role" | "rejected" | "unreachable" };

type Hook = { id?: unknown; url?: unknown };

/** Whether two addresses name one hook, however GitLab and ocra write them. */
function sameHookUrl(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      u.hash = "";
      return `${u.origin}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      return null;
    }
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

const hooksUrl = (t: HookTarget) =>
  `${t.instance}/api/v4/projects/${encodeURIComponent(t.projectId)}/hooks`;

const headers = (t: HookTarget) => ({
  authorization: `Bearer ${t.token}`,
  accept: "application/json",
  "content-type": "application/json",
});

const failed = (status: number): HookResult =>
  status === 401
    ? { ok: false, reason: "rejected" }
    : // GitLab answers 404 for a project the token cannot see, 403 below Maintainer.
      status === 403 || status === 404
      ? { ok: false, reason: "role" }
      : { ok: false, reason: "unreachable" };

const hookId = (h: Hook | null | undefined) =>
  typeof h?.id === "number" && Number.isSafeInteger(h.id) ? String(h.id) : null;

async function findHook(t: HookTarget, url: string, known: string | null) {
  const listed = await platformJson<Hook[]>(
    `${hooksUrl(t)}?per_page=${PAGE}`,
    { headers: headers(t) },
    MAX_LIST_BYTES,
  );
  if (!listed) return { failed: failed(0) };
  if (listed.status !== 200) return { failed: failed(listed.status) };
  const hooks = Array.isArray(listed.body) ? listed.body : [];
  const ours =
    hooks.find((h) => known !== null && hookId(h) === known) ??
    hooks.find((h) => typeof h.url === "string" && sameHookUrl(h.url, url));
  return { id: hookId(ours) };
}

/**
 * Adds the project's hook to `url` with `secret`, or updates the one that
 * already points there (or the one ocra kept the id of), so a second call
 * leaves one hook.
 */
export async function provisionGitlabHook(
  t: HookTarget,
  url: string,
  secret: string,
  known: string | null,
): Promise<HookResult> {
  const found = await findHook(t, url, known);
  if ("failed" in found) return found.failed;
  const body = JSON.stringify({ url, token: secret, enable_ssl_verification: true, ...EVENTS });
  const answer = await platformSend<Hook>(found.id ? `${hooksUrl(t)}/${found.id}` : hooksUrl(t), {
    method: found.id ? "PUT" : "POST",
    headers: headers(t),
    body,
  });
  if (!answer) return failed(0);
  if (answer.status !== 200 && answer.status !== 201) return failed(answer.status);
  const id = hookId(answer.body) ?? found.id;
  return id ? { ok: true, id } : failed(0);
}

/** Removes the hook ocra added; true when it is gone, already or now. */
export async function removeGitlabHook(t: HookTarget, id: string): Promise<boolean> {
  if (!/^\d+$/.test(id)) return false;
  const answer = await platformSend(`${hooksUrl(t)}/${id}`, {
    method: "DELETE",
    headers: headers(t),
  });
  return !!answer && (answer.status === 204 || answer.status === 200 || answer.status === 404);
}
