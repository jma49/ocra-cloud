import { type Json, MR, PERSON, PROJECT, STACKED, type User } from "./gitlab-project.js";
import type { BareRepository } from "./gitlab-repository.js";

// The stand-in GitLab's merge requests: the reviewed one and the one stacked
// on it, their discussions, merges and retargets, the merge train, the
// repository's files and commits API, and the commit statuses posted.

type Note = {
  id: number;
  body: string;
  author: User;
  system: false;
  type: string | null;
  resolvable: boolean;
  resolved: boolean;
  position?: unknown;
};
type Discussion = { id: string; individual_note: boolean; notes: Note[] };
type Pull = {
  iid: number;
  title: string;
  description: string;
  source_branch: string;
  target_branch: string;
  state: "opened" | "merged";
};
type Action = { action: string; file_path: string; content: string; last_commit_id?: string };
type Fields = {
  body?: string;
  position?: unknown;
  sha?: string;
  target_branch?: string;
  branch?: string;
  commit_message?: string;
  actions?: Action[];
};

export function mergeRequestApi(repo: BareRepository, url: () => string) {
  const discussions: Discussion[] = [];
  const statuses: unknown[] = [];
  const commits: { user: string; branch: string; message: string; sha: string }[] = [];
  /** The active merge train's cars, by merge request, in the order they joined. */
  const train = new Map<number, { status: "fresh" }>();
  /** The issues a merge request closes when it merges. */
  const closes = new Map<number, () => unknown>();
  const pulls = new Map<number, Pull>([
    [
      MR,
      {
        iid: MR,
        title: "Count retries from zero",
        description: "Retries start at zero now.\n\nCloses #12",
        source_branch: "feature",
        target_branch: "main",
        state: "opened",
      },
    ],
    [
      STACKED,
      {
        iid: STACKED,
        title: "Back off between retries",
        description: "",
        source_branch: "backoff",
        target_branch: "feature",
        state: "opened",
      },
    ],
  ]);
  let nextId = 1000;
  // What GitLab keeps as each merge request's ref: its source branch's head.
  const syncRefs = () => {
    for (const p of pulls.values()) {
      repo.setRef(`refs/merge-requests/${p.iid}/head`, repo.at(p.source_branch));
    }
  };
  syncRefs();

  const note = (author: User, body: string, extra = {}): Note => ({
    id: nextId++,
    body,
    author: { id: author.id, username: author.username },
    system: false,
    type: null,
    resolvable: false,
    resolved: false,
    ...extra,
  });

  const view = (p: Pull) => {
    const sha = repo.at(p.source_branch);
    const base = repo.mergeBase(p.target_branch, sha);
    return {
      iid: p.iid,
      id: 5000 + p.iid,
      project_id: PROJECT.id,
      title: p.title,
      description: p.description,
      state: p.state,
      detailed_merge_status: p.state === "opened" ? "mergeable" : "not_open",
      draft: false,
      author: { id: PERSON.id, username: PERSON.username },
      web_url: `${url()}/${PROJECT.path}/-/merge_requests/${p.iid}`,
      source_project_id: PROJECT.id,
      target_project_id: PROJECT.id,
      source_branch: p.source_branch,
      target_branch: p.target_branch,
      sha,
      labels: [],
      changes_count: "1",
      diff_refs: { base_sha: base, start_sha: base, head_sha: sha },
    };
  };

  function pullRoute(
    method: string,
    iid: number,
    at: string,
    fields: Fields,
    user: User,
    json: Json,
  ) {
    const pull = pulls.get(iid);
    if (!pull) return json({ message: "404 Not found" }, 404);
    if (at === "" && method === "GET") return json(view(pull));
    if (at === "" && method === "PUT") {
      if (fields.target_branch) pull.target_branch = fields.target_branch;
      return json(view(pull));
    }
    if (at === "/merge" && method === "PUT") {
      if (pull.state !== "opened") return json({ message: "405 Method Not Allowed" }, 405);
      if (fields.sha !== repo.at(pull.source_branch)) {
        return json({ message: "SHA does not match HEAD of source branch" }, 409);
      }
      repo.merge(pull.target_branch, fields.sha, `Merge branch '${pull.source_branch}'`);
      pull.state = "merged";
      train.delete(iid);
      return json(view(pull));
    }
    if (at === "/closes_issues") return json(closes.has(iid) ? [closes.get(iid)?.()] : []);
    if (at === "/cancel_merge_when_pipeline_succeeds" && method === "POST") {
      train.delete(iid);
      return json(view(pull), 201);
    }
    if (iid !== MR) return json([]);
    if (at === "/discussions" && method === "GET") return json(discussions);
    if (at === "/notes" && method === "GET") return json(discussions.flatMap((d) => d.notes));
    if (at === "/discussions" && method === "POST") {
      const first = note(user, fields.body ?? "", {
        type: fields.position ? "DiffNote" : "DiscussionNote",
        resolvable: true,
        ...(fields.position ? { position: fields.position } : {}),
      });
      const discussion = { id: `d${first.id}`, individual_note: false, notes: [first] };
      discussions.push(discussion);
      return json(discussion, 201);
    }
    if (at === "/notes" && method === "POST") {
      const created = note(user, fields.body ?? "");
      discussions.push({ id: `d${created.id}`, individual_note: true, notes: [created] });
      return json(created, 201);
    }
    const reply = /^\/discussions\/([^/]+)\/notes$/.exec(at);
    if (reply && method === "POST") {
      const discussion = discussions.find((d) => d.id === decodeURIComponent(reply[1] ?? ""));
      if (!discussion) return json({ message: "404 Discussion Not Found" }, 404);
      const created = note(user, fields.body ?? "", { type: "DiscussionNote" });
      discussion.notes.push(created);
      return json(created, 201);
    }
    const edit = /^\/notes\/(\d+)$/.exec(at);
    if (edit && method === "PUT") {
      const found = discussions.flatMap((d) => d.notes).find((n) => n.id === Number(edit[1]));
      if (!found) return json({ message: "404 Note Not Found" }, 404);
      found.body = fields.body ?? found.body;
      return json(found);
    }
    return json([]);
  }

  function trainRoute(method: string, iid: number, fields: Fields, json: Json) {
    const pull = pulls.get(iid);
    if (method === "GET") {
      const car = train.get(iid);
      if (!car || !pull) return json({ message: "404 Not found" }, 404);
      return json({ ...car, target_branch: pull.target_branch, merge_request: { iid } });
    }
    if (pull?.state !== "opened") return json({ message: "400 Bad request" }, 400);
    if (fields.sha !== repo.at(pull.source_branch)) return json({ message: "409 Conflict" }, 409);
    train.set(iid, { status: "fresh" });
    return json(
      [{ status: "fresh", target_branch: pull.target_branch, merge_request: { iid } }],
      201,
    );
  }

  /** The repository's files at a ref, and commits to a branch, as GitLab's API makes them. */
  function repositoryRoute(
    method: string,
    at: string,
    query: URLSearchParams,
    fields: Fields,
    user: User,
    json: Json,
  ) {
    const file = /^\/repository\/files\/([^/]+)$/.exec(at);
    if (file && method === "GET") {
      const path = decodeURIComponent(file[1] ?? "");
      const ref = query.get("ref") ?? "main";
      const content = Buffer.from(`${repo.read(ref, path)}\n`);
      return json({
        file_path: path,
        size: content.length,
        encoding: "base64",
        content: content.toString("base64"),
        last_commit_id: repo.lastCommit(ref, path),
      });
    }
    if (at === "/repository/commits" && method === "POST") {
      const branch = fields.branch ?? "";
      let sha = "";
      for (const a of fields.actions ?? []) {
        // GitLab refuses an update of a file that changed since it was read.
        if (a.last_commit_id && a.last_commit_id !== repo.lastCommit(branch, a.file_path)) {
          return json({ message: "A file has been changed since you started editing it" }, 400);
        }
        const content = Buffer.from(a.content, "base64");
        sha = repo.commitFile(branch, a.file_path, content, fields.commit_message ?? "");
      }
      syncRefs();
      commits.push({ user: user.username, branch, message: fields.commit_message ?? "", sha });
      return json({ id: sha }, 201);
    }
    return false;
  }

  return {
    discussions,
    statuses,
    commits,
    train,
    closes,
    pulls,
    /** Answers a project route it knows; false otherwise. */
    route(
      method: string,
      rest: string,
      query: URLSearchParams,
      body: unknown,
      user: User,
      json: Json,
    ) {
      const fields = (body ?? {}) as Fields;
      const pull = /^\/merge_requests\/(\d+)(\/.*)?$/.exec(rest);
      const car = /^\/merge_trains\/merge_requests\/(\d+)$/.exec(rest);
      if (rest === "/merge_requests" && method === "GET") {
        const state = query.get("state");
        const target = query.get("target_branch");
        const listed = [...pulls.values()].filter(
          (p) => (!state || p.state === state) && (!target || p.target_branch === target),
        );
        json(listed.map(view));
      } else if (pull) {
        pullRoute(method, Number(pull[1]), pull[2] ?? "", fields, user, json);
      } else if (car) {
        trainRoute(method, Number(car[1]), fields, json);
      } else if (rest === "/merge_trains" && method === "GET") {
        const target = query.get("target_branch");
        const cars = [...train].filter(([iid]) => pulls.get(iid)?.target_branch === target);
        json(cars.map(([iid, c]) => ({ ...c, target_branch: target, merge_request: { iid } })));
      } else {
        return repositoryRoute(method, rest, query, fields, user, json) !== false;
      }
      return true;
    },
    /** A person's comment on the merge request, in a new thread. */
    comment(body: string) {
      const created = note(PERSON, body, { type: "DiscussionNote", resolvable: true });
      discussions.push({ id: `d${created.id}`, individual_note: false, notes: [created] });
      return created;
    },
  };
}
