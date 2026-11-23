import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import { apiError, jsonBody } from "../http.js";
import { platformsOf } from "../platforms/registry.js";
import { checkGitlabAccessToken, sealRepoToken, type TokenCheck } from "../platforms/repo-token.js";
import { perMinute } from "../rate.js";
import { requireSession } from "../session.js";
import type { RepoAccessTokenView } from "../shared/index.js";
import type { AppEnv } from "../types.js";

// An enrolled GitLab project's own access token (docs/gitlab.md): a project
// or group access token whose bot posts the project's hosted reviews, for a
// team whose server has no GITLAB_BOT_TOKEN. Checked with GitLab once when
// given; answered only as whether there is one and its bot's username.

const tokenBody = z.object({
  token: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .regex(/^[\x21-\x7e]+$/, "a token"),
});

const REFUSED: Record<Exclude<TokenCheck, { ok: true }>["reason"], string> = {
  rejected: "GitLab refused this token: it is revoked, expired or mistyped",
  person:
    "this token is a person's: give a project or group access token, whose bot user posts the reviews",
  scope: "this token needs the scope api",
  role: "this token's bot needs at least the Developer role on the project",
  unreachable: "GitLab did not answer",
};

const refusal = (message: string) => ({ issues: [{ path: ["token"], message }] });

export function repoTokenRoute() {
  const route = new Hono<AppEnv>();

  route.put(
    "/repos/:id/access-token",
    requireSession(["web"]),
    perMinute("settings"),
    jsonBody(tokenBody),
    async (c) => {
      const { token } = c.req.valid("json");
      const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
      if (!repo) return apiError(c, "not_found");
      if (repo.platform !== "gitlab") {
        return apiError(c, "invalid_body", refusal("only a GitLab project takes an access token"));
      }
      const platform = platformsOf(c.env, c.req.url).find(
        (p) => p.kind === repo.platform && p.host === repo.host,
      );
      if (!platform) return apiError(c, "not_found");
      const check = await checkGitlabAccessToken(platform.url, token, repo.platformRepoId);
      if (!check.ok) {
        return check.reason === "unreachable"
          ? apiError(c, "upstream_unreachable")
          : apiError(c, "invalid_body", refusal(REFUSED[check.reason]));
      }
      const sealed = await sealRepoToken(c.env.MASTER_KEY, repo, token);
      const changed = await c.var.data.update("reviewRepos", repo.id, {
        accessTokenWrappedKey: sealed.wrappedKey,
        accessTokenCiphertext: sealed.ciphertext,
        accessTokenBot: check.bot,
      });
      if (!changed) return apiError(c, "not_found");
      await audit(c.var.data, "auto_review.access_token_set", {
        repo: repo.fullName,
        bot: check.bot,
      });
      return c.json({
        hasAccessToken: true,
        accessTokenBot: check.bot,
      } satisfies RepoAccessTokenView);
    },
  );

  route.delete("/repos/:id/access-token", requireSession(["web"]), async (c) => {
    const repo = await c.var.data.get("reviewRepos", c.req.param("id"));
    const changed =
      repo &&
      (await c.var.data.update("reviewRepos", repo.id, {
        accessTokenWrappedKey: null,
        accessTokenCiphertext: null,
        accessTokenBot: null,
      }));
    if (!repo || !changed) return apiError(c, "not_found");
    await audit(c.var.data, "auto_review.access_token_cleared", { repo: repo.fullName });
    return c.json({ hasAccessToken: false, accessTokenBot: null } satisfies RepoAccessTokenView);
  });

  return route;
}
