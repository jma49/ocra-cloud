import { Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import { proposalBranch } from "./platforms/files.js";
import { perMinute } from "./rate.js";
import {
  checkRepoConfig,
  MAX_REPO_CONFIG_BYTES,
  REPO_CONFIG_PATHS,
  schemaIdOf,
  textOf,
} from "./repo-config-file.js";
import { reachRepo, repoRef } from "./repo-head.js";
import { requireSession } from "./session.js";
import {
  REPO_CONFIG_FILES,
  type RepoConfigChangeView,
  type RepoConfigView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A repository's committed review configuration (.ocra/config.json, and its
// rules in .ocra/rules.json), managed from the console as the signed-in
// user: read live at the default branch, and an edit committed as the user
// on a new branch opened as a pull request (or, when asked, on the default
// branch), refused before it is sent when the engine would not read it.
// The platform decides what the user may read and write; nothing is kept.

export const repoConfigRoute = new Hono<AppEnv>();

const BLOB_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CONFIG_BRANCH = "ocra/config-";
const file = z.enum(REPO_CONFIG_FILES).default("config");
const getQuery = z.object({ ...repoRef, file });
const putBody = z.object({
  ...repoRef,
  file,
  text: z.string().min(1).max(MAX_REPO_CONFIG_BYTES),
  /** The blob the edit was made on; null adds a file that must not exist yet. */
  expected: z.string().regex(BLOB_ID).nullable(),
  /** Commit on the default branch instead of opening a pull request; the platform decides if the user may. */
  direct: z.boolean().default(false),
});

repoConfigRoute.get("/", requireSession(["web"]), perMinute("platform"), async (c) => {
  const query = getQuery.safeParse(c.req.query());
  if (!query.success) return apiError(c, "not_found");
  const reached = await reachRepo(c, query.data);
  if ("refusal" in reached) return reached.refusal;
  const { platform, token, head } = reached;
  const path = REPO_CONFIG_PATHS[query.data.file];
  const [read] =
    (await platform.files.read(token, head, head.commit, [path], MAX_REPO_CONFIG_BYTES)) ?? [];
  // "": the platform named the path but did not give its blob, as for a directory or a failed read.
  if (!read || read.blobId === "") return apiError(c, "upstream_unreachable");
  const view: RepoConfigView = {
    platform: platform.kind,
    repo: head.fullName,
    branch: head.branch,
    commit: head.commit,
    file: query.data.file,
    path,
    blobId: read.blobId,
    text: null,
    value: null,
    parseError: null,
    errors: [],
    moreErrors: false,
    schema: schemaIdOf(query.data.file),
    lastCommit: read.lastCommit,
  };
  if (read.blobId === null) return c.json(view);
  const text = read.bytes ? textOf(read.bytes) : { reason: "it could not be read" };
  if (typeof text !== "string") return c.json({ ...view, parseError: text.reason });
  const checked = checkRepoConfig(query.data.file, text);
  if (checked.kind === "unparsed") return c.json({ ...view, text, parseError: checked.reason });
  return c.json({
    ...view,
    text,
    value: checked.value,
    errors: checked.errors,
    moreErrors: checked.more,
  } satisfies RepoConfigView);
});

repoConfigRoute.post(
  "/",
  requireSession(["web"]),
  perMinute("platform"),
  // The text, JSON-escaped, with room for the other fields.
  jsonBody(putBody, { max: 2 * MAX_REPO_CONFIG_BYTES + 4096 }),
  async (c) => {
    const body = c.req.valid("json");
    const path = REPO_CONFIG_PATHS[body.file];
    const content = new TextEncoder().encode(body.text);
    if (content.byteLength > MAX_REPO_CONFIG_BYTES) {
      return apiError(c, "invalid_body", {
        issues: [{ path: ["text"], message: `larger than ${MAX_REPO_CONFIG_BYTES} bytes` }],
      });
    }
    const checked = checkRepoConfig(body.file, body.text);
    if (checked.kind === "unparsed") {
      return apiError(c, "invalid_body", { issues: [{ path: ["text"], message: checked.reason }] });
    }
    if (checked.errors.length > 0) {
      return apiError(c, "invalid_body", {
        issues: checked.errors.map((e) => ({ path: ["text", ...e.path], message: e.message })),
        more: checked.more,
      });
    }
    const reached = await reachRepo(c, body);
    if ("refusal" in reached) return reached.refusal;
    const { platform, token, head } = reached;
    const message = `chore(ocra): ${body.expected === null ? "add" : "update"} ${path}`;
    const result = await platform.files.commit(token, head, {
      path,
      content,
      expected: body.expected,
      message,
      pull: body.direct
        ? null
        : {
            branch: proposalBranch(CONFIG_BRANCH),
            title: message,
            body: `A change to \`${path}\` made in the ocra Cloud console, checked against the schema the engine reads it with.`,
          },
    });
    if (!result) return apiError(c, "upstream_unreachable");
    return c.json({
      outcome: result.outcome,
      path,
      pull: result.pull,
    } satisfies RepoConfigChangeView);
  },
);
