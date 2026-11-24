import type { AutoReviewService } from "./auto-review/routes.js";
import type { SessionAccount } from "./db/accounts.js";
import type { Db } from "./db/client.js";
import type { Scoped } from "./db/scoped.js";
import type { Mailer } from "./notify/email.js";
import type { WebhookPost } from "./notify/webhooks.js";
import type { BotTokens } from "./platforms/bot.js";
import type { PullsHub } from "./pull-events/hub.js";
import type { PullGuides } from "./pull-guides.js";

/**
 * What the app reads from its host: settings, secrets and rate limiters,
 * never the database binding, which each entry opens itself (src/index.ts
 * on Workers, src/node/ when self-hosted), nor the pull events' (Host.pullsHub).
 */
export type AppBindings = Widen<Omit<Env, "DB" | "PULL_EVENTS" | GithubApp>> &
  Partial<Record<GithubApp, string>>;
/** Always set on Workers; a self-hosted server may sign people in through OpenID Connect only. */
type GithubApp = "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET" | "GITHUB_APP_SLUG";
/** A self-hosted server sets its own GitHub App and limits: any string, not the Worker's. */
type Widen<T> = { [K in keyof T]: NonNullable<T[K]> extends string ? string : T[K] };

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    db: Db;
    clientAddress: string;
    /** The ocra bot, on a self-hosted server that has one. */
    bots: BotTokens | undefined;
    /** Set by requireSession: the signed-in account and its scoped data. */
    session: SessionAccount;
    data: Scoped;
    /** Where the host reviews pull requests itself (src/node/). */
    autoReview?: AutoReviewService;
    /** The host's mailer; undefined where it sends no email (the Worker). */
    mailer: Mailer | undefined;
    /** How the host posts webhooks; fetch where it gives none (the Worker). */
    webhookPost: WebhookPost | undefined;
    /** Where webhooks tell open consoles of pull request changes; undefined where the host has none. */
    pullsHub: PullsHub | undefined;
    /** What writes pull requests' tours and highlights; undefined where the host has nothing. */
    pullGuides: PullGuides | undefined;
  };
};
