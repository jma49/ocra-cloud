import {
  LEARNING_ID,
  LEARNINGS_DIR,
  learningFrontmatterSchema,
  learningIdOf,
  MAX_LEARNING_BODY,
  MAX_LEARNINGS,
} from "@open-cr-agent/cloud-contract";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { apiError, jsonBody } from "./http.js";
import { learningFile, parseLearning } from "./learning-file.js";
import { COMMIT_ID } from "./platforms/contents.js";
import { type LearningChange, type LearningRead, PROPOSAL_BRANCH } from "./platforms/learnings.js";
import type { CodePlatform } from "./platforms/platform.js";
import { reach, repoName } from "./pull-page.js";
import { perMinute } from "./rate.js";
import { requireSession } from "./session.js";
import {
  CODE_PLATFORMS,
  type InvalidLearningView,
  type LearningChangeView,
  type LearningProposalsView,
  type LearningProposalView,
  type LearningsView,
  type LearningView,
} from "./shared/index.js";
import type { AppEnv } from "./types.js";

// A repository's learnings, managed from the console as the signed-in user:
// read live at the default branch, the open proposals of `ocra learn
// --propose`, and an edit, addition or deletion committed as the user on a
// new branch opened as a pull request (or, when asked, on the default branch).
// The platform decides what the user may read and write; nothing is kept.

export const learningsRoute = new Hono<AppEnv>();

/** Learning files read per page: each costs a platform call on GitLab. */
const LEARNINGS_PAGE = 50;
/** Learning files read per proposal. */
const MAX_PROPOSAL_FILES = 20;
const BLOB_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const MAX_CHANGE_BYTES = 64 * 1024;

const repoRef = { platform: z.enum(CODE_PLATFORMS), repo: repoName };
const listQuery = z.object({ ...repoRef, after: z.string().regex(LEARNING_ID).optional() });
const proposalsQuery = z.object(repoRef);
const target = {
  ...repoRef,
  id: z.string().regex(LEARNING_ID),
  /** Commit on the default branch instead of opening a pull request; the platform decides if the user may. */
  direct: z.boolean().default(false),
};
const putBody = z.object({
  ...target,
  /** The blob the edit was made on; null adds a learning that must not exist yet. */
  expected: z.string().regex(BLOB_ID).nullable(),
  learning: learningFrontmatterSchema.extend({
    created: z.iso.date().optional(),
    body: z.string().trim().min(1).max(MAX_LEARNING_BODY),
  }),
});
const deleteBody = z.object({ ...target, expected: z.string().regex(BLOB_ID) });

type RepoRef = z.output<typeof proposalsQuery>;
const byKind = (ref: RepoRef) => (p: CodePlatform) => p.kind === ref.platform;

/** The platform, the token and the repository's default branch head, or the refusal. */
async function reachRepo(c: Context<AppEnv>, ref: RepoRef) {
  const reached = await reach(c, byKind(ref));
  if ("refusal" in reached) return { refusal: reached.refusal } as const;
  const head = await reached.platform.contents.head(reached.token, ref.repo);
  if (!head || !COMMIT_ID.test(head.commit)) return { refusal: apiError(c, "not_found") } as const;
  return { ...reached, head } as const;
}

function viewsOf(reads: LearningRead[]) {
  const learnings: LearningView[] = [];
  const invalid: InvalidLearningView[] = [];
  for (const read of reads) {
    const id = learningIdOf(read.path);
    const parsed = read.bytes ? parseLearning(read.bytes) : "it could not be read";
    if (!id || typeof parsed === "string") {
      invalid.push({
        path: read.path,
        blobId: read.blobId,
        reason: typeof parsed === "string" ? parsed : "its name is not a learning's",
      });
      continue;
    }
    const f = parsed.frontmatter;
    learnings.push({
      id,
      path: read.path,
      blobId: read.blobId,
      title: f.title,
      body: parsed.body,
      paths: f.paths,
      symbols: f.symbols,
      keywords: f.keywords,
      critical: f.critical,
      source: f.source ? { kind: f.source.kind, ref: f.source.ref ?? null } : null,
      created: f.created,
      lastCommit: read.lastCommit,
    });
  }
  return { learnings, invalid };
}

learningsRoute.get("/", requireSession(["web"]), perMinute("platform"), async (c) => {
  const query = listQuery.safeParse(c.req.query());
  if (!query.success) return apiError(c, "not_found");
  const reached = await reachRepo(c, query.data);
  if ("refusal" in reached) return reached.refusal;
  const { platform, token, head } = reached;
  const entries = await platform.learnings.list(token, head, head.commit);
  if (!entries) return apiError(c, "upstream_unreachable");
  const markdown = entries.filter((e) => e.path.endsWith(".md"));
  // As the engine reads them: by name, the first MAX_LEARNINGS.
  const named = markdown
    .flatMap((e) => {
      const id = learningIdOf(e.path);
      return id ? [{ ...e, id }] : [];
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, MAX_LEARNINGS);
  const after = query.data.after;
  const rest = after === undefined ? named : named.filter((e) => e.id > after);
  const page = rest.slice(0, LEARNINGS_PAGE);
  const reads = await platform.learnings.read(
    token,
    head,
    head.commit,
    page.map((e) => e.path),
  );
  if (!reads) return apiError(c, "upstream_unreachable");
  const { learnings, invalid } = viewsOf(reads);
  const misnamed =
    after === undefined
      ? markdown
          .filter((e) => !learningIdOf(e.path))
          .map((e) => ({
            path: e.path,
            blobId: e.blobId,
            reason: "its name is not lowercase letters, digits and hyphens",
          }))
      : [];
  return c.json({
    platform: platform.kind,
    repo: head.fullName,
    branch: head.branch,
    commit: head.commit,
    learnings,
    invalid: [...misnamed, ...invalid],
    total: named.length,
    next: rest.length > page.length ? (page.at(-1)?.id ?? null) : null,
  } satisfies LearningsView);
});

learningsRoute.get("/proposals", requireSession(["web"]), perMinute("platform"), async (c) => {
  const query = proposalsQuery.safeParse(c.req.query());
  if (!query.success) return apiError(c, "not_found");
  const reached = await reachRepo(c, query.data);
  if ("refusal" in reached) return reached.refusal;
  const { platform, token, head } = reached;
  const listed = await platform.learnings.proposals(token, head, head.branch);
  if (!listed) return apiError(c, "upstream_unreachable");
  const proposals: LearningProposalView[] = [];
  for (const p of listed.proposals) {
    const changes = await platform.changes.changes(token, head.fullName, p.number);
    if (!changes || !COMMIT_ID.test(changes.head)) continue;
    const kept = changes.files.filter((f) => f.status !== "removed" && learningIdOf(f.path));
    const removed = changes.files.flatMap((f) => {
      const gone = f.status === "removed" ? f.path : f.status === "renamed" ? f.oldPath : undefined;
      const id = gone && learningIdOf(gone);
      return id ? [id] : [];
    });
    const paths = kept.slice(0, MAX_PROPOSAL_FILES).map((f) => f.path);
    const reads = await platform.learnings.read(token, head, changes.head, paths);
    const { learnings, invalid } = viewsOf(reads ?? []);
    proposals.push({ ...p, head: changes.head, learnings, invalid, removed });
  }
  return c.json({ proposals, more: listed.more } satisfies LearningProposalsView);
});

/** A proposal branch of the engine's form, unique to this change. */
function branchName(now = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const tail = [...crypto.getRandomValues(new Uint8Array(3))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${PROPOSAL_BRANCH}${stamp}-${tail}`;
}

async function sendChange(
  c: Context<AppEnv>,
  ref: z.output<typeof deleteBody> | z.output<typeof putBody>,
  change: Omit<LearningChange, "path" | "pull" | "message">,
  verb: "add" | "update" | "delete",
) {
  const path = `${LEARNINGS_DIR}/${ref.id}.md`;
  // The path is built from a checked id; read back, it must name that id and nothing else.
  if (learningIdOf(path) !== ref.id) return apiError(c, "path_not_allowed");
  const reached = await reachRepo(c, ref);
  if ("refusal" in reached) return reached.refusal;
  const { platform, token, head } = reached;
  const message = `chore(ocra): ${verb} learning ${ref.id}`;
  const result = await platform.learnings.change(token, head, {
    ...change,
    path,
    message,
    pull: ref.direct
      ? null
      : {
          branch: branchName(),
          title: message,
          body: `A change to \`${path}\` made in the ocra Cloud console. Reviews give each learning to the changes it applies to.`,
        },
  });
  if (!result) return apiError(c, "upstream_unreachable");
  return c.json({ outcome: result.outcome, path, pull: result.pull } satisfies LearningChangeView);
}

learningsRoute.post(
  "/",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(putBody, { max: MAX_CHANGE_BYTES }),
  async (c) => {
    const body = c.req.valid("json");
    const { body: text, created, ...frontmatter } = body.learning;
    const file = learningFile({
      frontmatter: { ...frontmatter, created: created ?? new Date().toISOString().slice(0, 10) },
      body: text,
    });
    if (typeof file === "string") {
      return apiError(c, "invalid_body", { issues: [{ path: ["learning"], message: file }] });
    }
    const verb = body.expected === null ? "add" : "update";
    return sendChange(c, body, { content: file, expected: body.expected }, verb);
  },
);

learningsRoute.post(
  "/delete",
  requireSession(["web"]),
  perMinute("platform"),
  jsonBody(deleteBody),
  async (c) => {
    const body = c.req.valid("json");
    return sendChange(c, body, { content: null, expected: body.expected }, "delete");
  },
);
