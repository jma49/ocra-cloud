# Ocra Cloud

Ocra Cloud is the optional service for the [Ocra review engine](https://github.com/ocrahq/Open-CR-Agent). The engine, CLI and GitHub Action work without a Cloud account. The hosted service is in early access: sign in with GitHub, bring a model provider key, and install the Ocra Cloud GitHub App on the repositories you want it to review. Hosted auto review does not need a review workflow or model secrets in those repositories.

[Product site](https://ocracloud.com/) · [Hosted console](https://app.ocracloud.com/) · [User guide](https://ocracloud.com/docs/cloud) · [Self-hosting](docs/self-hosting.md)

The console groups pull requests in one inbox. A pull request page shows the diff and review, with a walkthrough and committable fixes when the review has them. Enrolled repositories can use pre-merge checks and bot-assisted fixes. The public `/demo` route in this repository replays sample review events in the browser without signing in, cloning a repository or calling a model.

## How it fits together

| Path | What happens |
|---|---|
| CLI or GitHub Action without Cloud | The engine runs on your machine or CI runner. No Cloud account or gateway is required. |
| CLI signed in with `ocra login` | The CLI still runs the review. When configured to use the Cloud gateway, model requests pass through the service to your provider using your stored key. Review uploads contain counts and run metadata by default; findings and the code they quote are opt-in. |
| Auto review | Platform webhooks queue jobs for enrolled repositories with automatic reviews enabled. The runner clones the repository and runs the bundled Ocra CLI; results return to the service and the bot publishes the review on the platform. By default, server-run reviews retain redacted findings and quoted code even if CLI findings sharing is off. |
| Hosted deployment | A Cloudflare Worker serves the Hono API and React console and stores account data in D1. It queues reviews for [remote runners](docs/runner.md); it does not clone repositories or run the CLI itself. |
| Self-hosted deployment | A Node server serves the same API and console, with Postgres or libSQL (SQLite). It can execute reviews locally or delegate to remote runners. Docker Compose includes Postgres, Caddy and first-run setup; see also the [self-managed GitLab guide](docs/gitlab.md). |

Model keys are encrypted at rest. The gateway forwards prompts and responses without logging their bodies; the [usage ledger](docs/usage-reconciliation.md) records tokens and estimated costs, not prompts. Account data is accessed through the scoped database layer. See the [data policy](https://app.ocracloud.com/privacy) for what is kept, [ADR-0024](https://github.com/ocrahq/Open-CR-Agent/blob/main/docs/adr/0024-ocra-cloud.md) for the original Cloud design, and [ADR-0046](https://github.com/ocrahq/Open-CR-Agent/blob/main/docs/adr/0046-hosted-review-runner.md) for hosted reviews.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | The API under `/api` (Hono), the same on every host: `createApp(openDb)` |
| `src/index.ts` | The Worker: D1, rate limiting bindings, daily retention and hourly maintenance; a Durable Object notifies open inboxes of pull request changes |
| `src/node/` | The self-hosted server: the app on Node with Postgres or libSQL (SQLite), rate limits in memory or the database, the web app from disk (`docs/self-hosting.md`, `Dockerfile`) |
| `src/auto-review/` | Pull requests reviewed by the deployment itself: the queue, the server's half of a job (`work.ts`) and the API remote runners take jobs through (`runner-api.ts`); the machine's half is `src/node/review-runner.ts`, run in the self-hosted server or by a remote runner (`src/node/runner.ts`, `docs/runner.md`), which is how the Worker reviews |
| `src/db/client.ts` | `Db`, the common query interface for D1, libSQL and Postgres, and `changedRows` |
| `src/db/schema.ts` | D1 tables (Drizzle, SQLite dialect; the same ORM targets Postgres) |
| `src/db/scoped.ts` | The only way to touch an account's rows: every query filters by the account |
| `src/shared/` | What the Worker and the web share, with no Drizzle: the domain's types (from the contract where it has them), the `ocra-<provider>/<model>` form (`parseModelId`, `formatModelId`), the engine's reviewers and roles, the effort hint table. The web imports `src/` only from here, and only types from the contract (`test/shared-boundary.test.ts`) |
| `src/audit-log.ts` | `GET /api/audit?kind=&since=&until=&after=&limit=`, the account's own audit log (web session): newest first, 50 a page by a cursor, each event with only its kind's fields (`AUDIT_FIELDS` in `src/shared/audit.ts`) |
| `src/search.ts` | `GET /api/search?q=&limit=`, the console's search (web session): the user's pull requests read live on each connected platform (one that fails or takes over 5 s is marked `error`, the rest still answer), the account's reviews, its findings only while it shares them, its enrolled and graph repositories, and the console's pages (`matchDestinations` in `src/shared/search.ts`, which the web can also run offline). `#123` and `owner/repo#123` jump to that pull request; learnings are not searched |
| `src/secrets.d.ts` | The Worker secrets' types, which `wrangler types` cannot see (it writes `src/worker-configuration.d.ts`) |
| `migrations/`, `migrations-pg/` | D1/SQLite and Postgres migrations, generated together by `npm run db:generate` |
| `web/` | The web app: React, built by Vite into `web/dist`, served as Workers static assets; its styles are in `web/src/styles/` by section (`styles.css` imports them in order, utilities last) |
| `test/`, `test-node/`, `test-pg/` | API tests on local D1 in workerd (`@cloudflare/vitest-plugin`) and on Postgres in PGlite, plus Node-specific server tests |
| `web/src/` | Console source and web tests (Vitest with happy-dom) |
| `scripts/` | Run by hand with Node: `rewrap-master-key.ts` and `bind-provider-keys.ts` (production key maintenance on D1; a self-hosted server rotates with `dist/rewrap-master-key.mjs`); type-checked by `scripts/tsconfig.json` |
| `docs/rotation.md` | How to rotate the master key and bind the stored keys |
| `tsconfig.base.json` | The compiler options the Worker, web and scripts configurations share |

## Commands

```sh
npm ci
npm run verify          # Biome, knip, types, tests, web/Node/runner builds
npm run dev             # web build + wrangler dev on http://localhost:8787
npm run db:generate     # after a schema change: writes SQLite and Postgres migrations
npm run types           # after a wrangler.jsonc change: regenerates Env
npm run deploy          # migrations on the remote D1, then the Worker (from a logged-in machine)
```

The engine's `@open-cr-agent/cloud-contract` (schemas, limits, vocabularies, redaction, fixtures) is an exact dependency. A change to a shape is made in the engine and released, then the pin is bumped here; Dependabot offers its minors and patches, never a major.

Vitest majors move together with `@cloudflare/vitest-plugin`, never through a standalone Dependabot update. Node is the version in `.nvmrc`, which CI reads too.

Production address: https://app.ocracloud.com (custom domain on the Worker); https://ocra-cloud.majincheng990128.workers.dev stays on for development. Workers free plan: its daily D1 rows and Worker requests are shared by every account, so the caps in `wrangler.jsonc` are sized for it, and `test/quota-budget.test.ts` measures what each request costs and checks that five accounts at every cap use at most half of each quota.
