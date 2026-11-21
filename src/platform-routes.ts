import { Hono } from "hono";
import { accountSalt } from "./db/accounts.js";
import { apiError } from "./http.js";
import { accessToken } from "./platforms/links.js";
import type { CodePlatform, PlatformRepo } from "./platforms/platform.js";
import { repoHashOf } from "./platforms/platform.js";
import { platformsOf } from "./platforms/registry.js";
import { perMinute } from "./rate.js";
import { MAX_NAMED } from "./repositories.js";
import { requireSession } from "./session.js";
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
        more: l.more,
        repositories: await Promise.all(
          l.repositories.map(async (r) => ({
            id: r.id,
            fullName: r.fullName,
            url: r.url,
            private: r.private,
            repoHash: salt ? await repoHashOf(salt, l.platform.host, r.fullName) : null,
          })),
        ),
      })),
    ),
  });
});

platformsRoute.get("/pulls", requireSession(), async (c) => {
  const platforms = await Promise.all(
    platformsOf(c.env, c.req.url).map(async (platform) => {
      const head = { platform: platform.kind, host: platform.host };
      const token = await accessToken(c.var.data, c.env, platform);
      if (!token) return { ...head, linked: false, failed: false, more: false, pulls: [] };
      const listing = await platform.listPulls(token);
      if (!listing) return { ...head, linked: true, failed: true, more: false, pulls: [] };
      return { ...head, linked: true, failed: false, ...listing };
    }),
  );
  return c.json({ platforms });
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
        .flatMap((l) => l.repositories.map((r) => ({ host: l.platform.host, name: r.fullName })))
        .slice(0, MAX_NAMED)
        .map(async (r) => ({ repoHash: await repoHashOf(salt, r.host, r.name), name: r.name })),
    ),
    MAX_NAMED,
  );
  return c.json({ named, sharing: true });
});
