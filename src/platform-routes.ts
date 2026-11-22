import { Hono } from "hono";
import { accountSalt } from "./db/accounts.js";
import { apiError } from "./http.js";
import { accessToken } from "./platforms/links.js";
import type { CodePlatform, PlatformRepo } from "./platforms/platform.js";
import { repoHashOf } from "./platforms/platform.js";
import { platformsOf } from "./platforms/registry.js";
import { sectionsOf } from "./pull-sections.js";
import { pullRepliesWaiting, pullSeenStates } from "./pull-unread.js";
import { pullVerdicts } from "./pull-verdicts.js";
import { perMinute } from "./rate.js";
import { MAX_NAMED } from "./repositories.js";
import { requireSession } from "./session.js";
import { type PullItem, pullUnread, stackPlaces } from "./shared/index.js";
import type { AppEnv } from "./types.js";

// What the signed-in user reaches on each connected code platform, read
// live with their token and never stored. With findings sharing on, each
// repository carries the hash the CLI sends for it, so the console can put
// reviews under real names.

export const platformsRoute = new Hono<AppEnv>();

type Listed = {
  platform: CodePlatform;
  linked: boolean;
  repositories: PlatformRepo[];
  more: boolean;
  failed: boolean;
};

async function listAll(c: {
  var: AppEnv["Variables"];
  env: AppEnv["Bindings"];
  req: { url: string };
}) {
  return Promise.all(
    platformsOf(c.env, c.req.url).map(async (platform): Promise<Listed> => {
      const empty = { platform, repositories: [], more: false };
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return { ...empty, linked: false, failed: false };
      const listing = await platform.listRepos(token);
      if (!listing) return { ...empty, linked: true, failed: true };
      return { platform, linked: true, failed: false, ...listing };
    }),
  );
}

platformsRoute.get("/repos", requireSession(), async (c) => {
  const listed = await listAll(c);
  const sharing = c.var.session.account.shareFindings;
  const salt = sharing ? await accountSalt(c.var.db, c.var.session.account.id) : null;
  return c.json({
    sharing,
    platforms: await Promise.all(
      listed.map(async (l) => ({
        platform: l.platform.kind,
        host: l.platform.host,
        linked: l.linked,
        failed: l.failed,
        installUrl: l.platform.install ?? null,
        more: l.more,
        repositories: await Promise.all(
          l.repositories.map(async (r) => ({
            id: r.id,
            fullName: r.fullName,
            url: r.url,
            private: r.private,
            repoHash: salt ? await repoHashOf(salt, l.platform, r.fullName) : null,
          })),
        ),
      })),
    ),
  });
});

// The pull requests asking the user's review, theirs open and theirs merged
// this week, each with the verdict of the account's newest review of it and
// whether it changed since the account last saw it (POST /api/pulls/seen),
// or since its inbox baseline when it never did, and how many replies wait
// for the user in review threads they started on it (repliesWaiting).
// With group=views it also answers the account's visible views (or the
// defaults while it has none), each with the pulls it holds, evaluated here
// over this same listing. Open pulls stacked on one another in a repository
// carry their place in the stack, read from this listing's branches alone.
platformsRoute.get("/pulls", requireSession(), async (c) => {
  const group = c.req.query("group");
  if (group !== undefined && group !== "views") {
    return apiError(c, "invalid_body", {
      issues: [{ path: ["group"], message: "group is views or left out" }],
    });
  }
  const listed = await Promise.all(
    platformsOf(c.env, c.req.url).map(async (platform) => {
      const head = { platform: platform.kind, host: platform.host };
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return { platform, head, linked: false, failed: false, more: false, pulls: [] };
      const listing = await platform.listPulls(token);
      if (!listing) return { platform, head, linked: true, failed: true, more: false, pulls: [] };
      return { platform, head, linked: true, failed: false, ...listing };
    }),
  );
  const [reviewsOf, seenOf, since] = await Promise.all([
    pullVerdicts(c.var.data, listed),
    pullSeenStates(c.var.data, listed),
    c.var.data.pullSeen.baseline(c.var.session.account.inboxSince),
  ]);
  const repliesOf = await pullRepliesWaiting(c.var.db, c.var.data, listed, seenOf, since);
  const platforms = listed.map(({ platform, head, pulls, ...rest }) => {
    const stacked = pulls.flatMap((p) =>
      p.state === "open" && p.branches ? [{ repo: p.repo, number: p.number, ...p.branches }] : [],
    );
    const places = stackPlaces(stacked);
    const placeOf = new Map(stacked.map((p, i) => [`${p.repo}#${p.number}`, places[i]]));
    return {
      ...head,
      ...rest,
      pulls: pulls.map((pull): PullItem => {
        const { branches: _, ...p } = pull;
        const { verdict, reviewedAt } = reviewsOf(platform, pull);
        const stack = placeOf.get(`${p.repo}#${p.number}`);
        const repliesWaiting = repliesOf(platform, pull);
        return {
          ...p,
          verdict,
          repliesWaiting,
          ...pullUnread(p, seenOf(platform, pull), reviewedAt, since, repliesWaiting),
          ...(stack ? { stack } : {}),
        };
      }),
    };
  });
  if (group !== "views") return c.json({ platforms });
  return c.json({ platforms, sections: await sectionsOf(c.var.data, platforms, Date.now()) });
});

// Names every repository the user reaches with its platform name, so the
// console shows it in place of the hash. Needs sharing: only then does the
// CLI hash with the account's salt.
platformsRoute.post("/sync-names", requireSession(), perMinute("settings"), async (c) => {
  if (!c.var.session.account.shareFindings) return c.json({ named: 0, sharing: false });
  const listed = await listAll(c);
  if (listed.every((l) => !l.linked)) return apiError(c, "github_user");
  const salt = await accountSalt(c.var.db, c.var.session.account.id);
  const named = await c.var.data.nameRepos(
    await Promise.all(
      listed
        .flatMap((l) => l.repositories.map((r) => ({ platform: l.platform, name: r.fullName })))
        .slice(0, MAX_NAMED)
        .map(async (r) => ({ repoHash: await repoHashOf(salt, r.platform, r.name), name: r.name })),
    ),
    MAX_NAMED,
  );
  return c.json({ named, sharing: true });
});
