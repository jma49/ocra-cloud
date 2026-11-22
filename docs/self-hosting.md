# Self-hosting ocra Cloud

The same API and web app as app.ocracloud.com, on Node with Postgres or a SQLite file instead of Cloudflare Workers and D1. `src/node/` is the only code that differs: it opens Postgres or libSQL, reads the client's address from the socket or a trusted proxy, keeps the rate limits in memory, runs the daily retention, and serves `web/dist`. `test-node/` runs the app this way in CI.

## Run it

With Docker Compose, on one machine: the server, and Caddy in front of it ending TLS (`selfhost/`).

```sh
cd selfhost
cp .env.example .env            # OCRA_DOMAIN, OCRA_TLS
cp ocra.env.example ocra.env    # the server's variables, below
docker compose up -d
```

`OCRA_TLS` says where the certificate comes from: `internal` (Caddy's own CA, for a trial), an email for a public name that Let's Encrypt can reach, or `/certs/<cert>.pem /certs/<key>.pem` with the company's certificate placed in `selfhost/certs/`. Compose sets `PUBLIC_URL` and `TRUSTED_PROXY_HOPS` for you. Data lives in the `ocra-data` volume.

Behind your own load balancer instead, run the image alone:

```sh
docker build -t ocra-cloud .
docker run -p 8787:8787 -v ocra-data:/data --env-file ocra.env ocra-cloud
```

Without Docker: `npm ci && npm run build:web && npm run build:node`, then `node dist/server.mjs` with the variables below. Migrations are applied at start.

## Variables

| Variable | Required | Meaning |
|---|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | one way to sign in | Your own GitHub App's client, with expiring user tokens and the repository permissions Contents and Pull requests set to read and write (the console comments, reviews, merges and commits a finding's fix as the user); its callback URL is `<PUBLIC_URL>/api/auth/github/callback` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | one way to sign in | An OpenID Connect provider: the company's SSO (Keycloak, Azure AD, Okta) or a self-hosted GitLab, which is one. A confidential client with the scopes `openid profile email` and the redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`; the issuer is the URL its discovery document names, such as `https://gitlab.example.com` |
| `OIDC_NAME` | no | the provider's name on the sign-in button, "SSO" when unset |
| `MASTER_KEY` | yes | base64 of 32 random bytes (`openssl rand -base64 32`); wraps every stored key. Losing it loses them |
| `MASTER_KEY_PREVIOUS` | during a rotation | as on Workers (`docs/rotation.md`) |
| `SESSION_SECRET` | yes | signs the sign-in state cookie |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | to connect GitLab | a GitLab OAuth application (scope `api`: the console comments, approves and merges as the user); its redirect URI is `<PUBLIC_URL>/api/platforms/gitlab/callback` |
| `GITLAB_URL` | for a self-hosted GitLab | the instance, such as `https://gitlab.example.com`; `https://gitlab.com` when unset |
| `PUBLIC_URL` | behind a TLS proxy | the address people open, such as `https://ocra.example.com` |
| `TRUSTED_PROXY_HOPS` | behind a proxy | how many proxies in front append to `X-Forwarded-For` (1 for one TLS proxy); the login code limits count by the address read past them. 0, the socket's peer, when unset |
| `MODEL_ENDPOINTS` | for company models | the company's own OpenAI-compatible model endpoints, as JSON (Company models below) |
| `DEFAULT_MODELS` | no | the default models, as JSON (`{"top": ["ocra-corp/qwen3-coder"], "light": "ocra-corp/qwen3-8b"}`), that an account starts with until it saves its own; each must be one the gateway serves |
| `BUILTIN_PROVIDERS` | no | `off` forwards to `MODEL_ENDPOINTS` only, never to the public providers; `on` when unset |
| `GITHUB_WEBHOOK_SECRET` | for GitHub code graphs | your GitHub App's webhook secret; the App's webhook URL is `<PUBLIC_URL>/api/webhooks/github` (`/api/graphs/webhooks/github`, its earlier address, still answers), subscribed to push and pull request events. The App's webhooks are refused without it |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | for GitHub auto review | your GitHub App's id and private key (PEM; `\n` for line breaks on one line). Each review gets an installation token limited to its repository; the App needs Contents read, Pull requests read and write, Checks read and write (for pre-merge checks), and the pull request, issue comment and pull request review comment webhook events |
| `GITLAB_BOT_TOKEN` | for GitLab auto review | a bot account's token (scope `api`), which posts the reviews |
| `AUTO_REVIEW_WORKERS` | no | reviews at once in this process (default 1; 0 only queues them for another process on the same database) |
| `GRAPH_WORKERS` | no | code graph builds a process runs at once, each of another repository; 1 when unset |
| `CODE_GRAPH` | no | what the server does with code graphs: `keep` (the default), `opt-in` (only for repositories added with the owner's consent) or `off` (none kept; the daily retention deletes any that are) |
| `DATABASE_URL` | no | a Postgres server's `postgres://user:password@host:5432/db`, or a libSQL URL: `file:/data/ocra-cloud.db` in the image, or a libSQL server's |
| `RATE_LIMITS` | with several processes | `database` counts the rate limits in the database, so that each holds for the deployment; `memory`, per process, when unset |
| `MIGRATE` | with several processes | `on` (the default) applies the migrations at start, `off` leaves them, `only` applies them and exits |
| `SMTP_URL` | for email notifications | the mail server, as `smtp://user:password@host:587` (STARTTLS when the server offers it) or `smtps://user:password@host:465`; without it email channels are refused |
| `SMTP_FROM` | with `SMTP_URL` | the address email is sent from, such as `ocra@example.com` |
| `PORT` | no | 8787 |
| `GATEWAY_DAILY_CALLS`, `REVIEW_DAILY_UPLOADS`, `REVIEW_MAX_FINDINGS`, `DEVICE_DAILY_CODES`, `DEVICE_DAILY_CODES_PER_NETWORK` | no | the Worker's defaults (`wrangler.jsonc`) |

Serve it over HTTPS: session cookies are `__Host-` cookies, which browsers keep only on secure origins.

## Company models

`MODEL_ENDPOINTS` declares the company's own model endpoints, such as an internal gateway in front of vLLM or a hosted model, as a JSON list:

```json
[
  {
    "id": "corp",
    "label": "Corp LLM",
    "base": "https://llm.corp.example/openai",
    "models": "/v1/models",
    "key": "the server's key for it"
  }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | lowercase letters, digits and `-`, not a built-in provider's id; models are named `ocra-<id>/<model>`, such as `ocra-corp/qwen3-coder` |
| `label` | yes | the name the console shows |
| `base` | yes | an http or https URL without credentials, query or fragment; the paths are appended to it |
| `paths` | no | the paths the gateway forwards, `["/v1/chat/completions"]` when unset; the CLI needs one ending in `/chat/completions` |
| `auth` | no | `bearer` (the default) or `x-api-key`: how the key goes on the request |
| `models` | no | a GET that lists the models in OpenAI's shape; it also checks a key |
| `key` | no | the server's own key: every account's calls use it and nobody stores one. Without it, each person adds their own key for the endpoint on the keys page |

With `DEFAULT_MODELS` naming them, a colleague who signs in for the first time reviews with the company's models without setting anything. The endpoints appear in the console's "Your company" group, and the CLI reaches them through the gateway like any other provider, with the same metering and daily caps. A declaration the server cannot read stops it from starting, naming the field. Keep the filled-in environment file secret when it holds a `key`.

## Postgres

For a team, keep the data in Postgres (13 or later): `DATABASE_URL=postgres://…`. With Compose, `docker-compose.postgres.yml` runs Postgres 17 in a container beside the server, its data in the `postgres-data` volume:

```sh
echo "OCRA_DB_PASSWORD=$(openssl rand -hex 24)" >> .env
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
```

A one-off `migrate` run applies `migrations-pg/` before the server starts. To use the company's own Postgres instead, leave that file out and set `DATABASE_URL` in `ocra.env`. The tables and values are those of the SQLite schema: times are milliseconds in `bigint` columns, JSON is text. Back up with `pg_dump`.

## Several processes

`docker-compose.replicas.yml` runs several ocra processes on this machine against its database, behind the same Caddy:

```sh
docker compose -f docker-compose.yml -f docker-compose.replicas.yml up -d
```

A one-off `migrate` run (`MIGRATE=only`) applies the migrations first; the replicas (`OCRA_REPLICAS` in `.env`, 2 by default) start after it with `MIGRATE=off` and `RATE_LIMITS=database`. Caddy sends requests to each in turn and skips one that fails its health check. The SQLite file runs in WAL mode, so readers do not wait for the writer. For processes on several machines, point `DATABASE_URL` at Postgres (add `-f docker-compose.postgres.yml` here) or a libSQL server, with the same two settings.

## Code graphs

An account adds a repository on the console's Code graphs page (or `/api/graphs/repos`); the server then keeps a graph of its default branch (symbol names, kinds and line numbers per file, never code), built after each push from the platform's tree and blob APIs with the account's own token, reading only the files that changed. Pushes arrive at `<PUBLIC_URL>/api/webhooks/github` (the GitHub App's webhook, signed with its secret) or `/api/graphs/webhooks/gitlab` (a project hook with the secret the server answers when the project is added). Builds older than 14 days are deleted daily, except each repository's newest; an account rebuilds a repository's graph from its branch's head, purges its graphs or removes it at any time, from the same page. The page is in the console only where `CODE_GRAPH` is not `off`. Builds run in the server process with the engine's tree-sitter parser (`@open-cr-agent/code-graph`); with several processes on one database, each build is claimed by one of them. `PUBLIC_URL` must be set for GitLab, whose token refresh names the server's address.

A pull request's page reads its diff live as the signed-in user (`GET /api/pulls/files`, at most 4 MB of diff per page) and sends their comment, review and merge to the platform as them (`POST /api/pulls/comment`, `/review`, `/merge`); only a web session may, and nothing read or sent is kept. A review or merge names the head commit the user read, and one that moved since answers `head_moved` instead of acting. GitLab takes approve and comment as verdicts, and merge or squash as merges. A review shared with its findings also keeps its walkthrough (overview, files in groups, diagram), redacted again on the server, on the review's page and in its export. A finding has a fix when the CLI shared one (0.10.0 and later) and the server's own redaction left its replacement whole. That fix is committed to the pull request's branch with `POST /api/pulls/apply-fix`, as the user, only while the pull request is still at the commit that was reviewed and the file is unchanged since; the finding is then marked fixed. Cycle time (`GET /api/insights/cycle?platform=…&days=…`, optionally `&repo=…` for every author's pull requests in one repository) reads up to 50 pull requests merged in the last 90 days at most, as the user, and times each from opened to the first review or comment by someone else and to merged; nothing is kept.

A repository's learnings (`.ocra/learnings/*.md`, ADR-0037 of the engine) are read live at its default branch as the signed-in user (`GET /api/learnings?platform=…&repo=…`, 50 files a page, `&after=<id>` for the next), parsed as a review would read them; files a review would skip are listed with the reason. `GET /api/learnings/proposals` lists the open pull requests from the repository's own `ocra/learnings-*` branches (at most 10) with the learnings each adds, changes or deletes. An addition, edit or deletion (`POST /api/learnings`, `POST /api/learnings/delete`) is committed as the user on a new `ocra/learnings-*` branch and opened as a pull request, or committed on the default branch with `direct: true` when the platform lets the user; it names the file's blob as the console read it, and a file changed, added or deleted since answers `conflict` instead of being overwritten. Only a web session may, and nothing read is kept. The upload contract does not say which learnings a review used, so the console shows no usage counts.

A pull request's impact (`/api/graphs/repos/<id>/impact?pull=<number>`) is computed from that graph on request: the platform's pull request API gives the changed files' hunk headers, the symbols the hunks touch on the graph's side are the changed ones, and their uses are the other files' identifiers of the same name, matched by name and not type-resolved. The code line of up to 40 uses is read from the platform at the graph's commit for the answer and not kept. The review page of a pull request's review shows it in a rail beside the findings when the console keeps a graph of that repository; a review uploaded before this server stored pull requests (migration `0028`) has none.

## Limits of this first version

- Set GitHub, OpenID Connect or both; the server refuses to start with neither. An account belongs to the identity it signed in with: the same person through GitHub and through SSO is two accounts.
- Back up the `/data` volume, or the Postgres database; there is no Time Travel as on D1.

## Auto review

With a bot's credentials and `PUBLIC_URL` set, the server reviews pull requests itself (ADR-0046 of the engine): an account enrolls a repository (`/api/auto-review/repos`; one account per repository, whose models, keys, budget and rules the reviews use), and a pull request is queued when it opens, reopens, leaves draft or gains commits. GitHub's events come through the App's webhook (`/api/webhooks/github`), GitLab's through a project hook to `/api/auto-review/webhooks/gitlab` with the secret the server answers when the repository is enrolled. A newer head supersedes a queued one, and one pull request is reviewed once at a time.

Each review clones the repository into a new temporary directory and runs the installed `ocra` CLI there, as CI does: `ocra review --pr <n> --publish --no-repo-config` (`--mr` on GitLab), signed in to this server as the enrolling account through a session made for the run. Nothing from the pull request runs. It posts as the bot, and gets only the variables it needs, none of this server's secrets. The directory and the session are removed when the run ends, whatever its outcome; a failed run is retried twice, five and ten minutes later. The image includes git; a server run outside it needs git on its `PATH`.

A comment that mentions `@ocra` on an enrolled repository's pull request, written by a person (never a bot), queues an answer, once per comment: `ocra reply --pr <n> --comment <id>` (`--inline` for a review comment, `--mr` on GitLab) runs the same way, and the CLI answers in the comment's thread or decides there is nothing to answer. GitHub sends these as the App's issue comment and pull request review comment events; on GitLab, tick Comments (note events) on the same project hook. A failed answer is retried like a review.

## Automation rules

An account sets up to 50 rules (`/api/automations/rules`), each a set of conditions that must all hold and the actions taken when they do. A `queued` rule runs when a pull request of an enrolled repository is queued for review, and can match the repository, the author (on GitLab known only when the merge request opens), the base branch, a title pattern (`*` and `?`) and labels. A `reviewed` rule runs when a pull request's review is uploaded, and can match the repository, a critical finding and the verdict. Changed paths are not a condition. The actions add labels, request reviewers and post a plain comment as the ocra bot, notify one of the account's channels, or skip the review (`queued` only). The bot writes only on repositories the account enrolled, and only on a server with a bot: elsewhere those actions are kept and logged as needing a self-hosted server. A `queued` rule acts when the pull request opens, reopens or leaves draft; on a push only its skip applies. Each rule runs once per event, `/api/automations/dry-run` says which rules match a described pull request, and `/api/automations/runs` lists what each run did, kept for 30 days.

## Pre-merge checks

An enrolled repository can carry up to 20 checks (`/api/merge-checks/repos/<id>/checks`, managed from the web session only), each `off`, `warn` or `block`: a linked issue (optionally open, or carrying a label), a title that starts with one of a list of prefixes or matches a glob of `*` and `?` (never a regular expression), a description that is filled in (a template's HTML comments do not count) and has the named section headings, a size limit in changed files or lines, no unresolved critical ocra finding on the reviewed head, and a check written in plain words. The plain-language checks are stored but not evaluated yet, and say so; the linked issue check waits, saying so, until the review of the head uploads the linked issues it found, which needs a later release of the CLI.

The server evaluates a pull request's checks on its current head when the webhook queues it, when its title or description is edited, and when its review is uploaded, and posts the result as the bot: one check run named `ocra / pre-merge` on GitHub, updated in place when the result changes (the App needs Checks write), or one commit status of that name on GitLab (the bot needs at least the Developer role). A blocking check that fails makes it fail; a failing warning makes it neutral on GitHub and success on GitLab, with the failure in its summary. A result is posted once per head and result. Without a bot, as on Workers, nothing is posted, but the pull request's page still reads the result (`/api/pulls/checks?platform=&repo=&number=`), evaluated as the signed-in user.

## Notifications

An account announces its reviews in Slack or WeCom group chats, or to email addresses (`/api/notifications/channels`, at most 10 in all). A chat channel takes the chat's incoming webhook address (`https://hooks.slack.com/services/…` or `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…`, no other host); an email channel takes one plain address. Either is stored encrypted under `MASTER_KEY` and never answered. Each channel hears about every review, reviews with findings, or only reviews with a critical finding. A message carries the review's counts, verdict, pull request and console links, and the titles of up to three critical or warning findings when the account shares findings. The server needs outbound HTTPS to those hosts. A message that fails is not retried; the channel shows how its last message went, and a test message checks it.

Email needs `SMTP_URL` and `SMTP_FROM`; the hosted Worker has no mailer, so it refuses email channels and `GET /api/notifications/channels` answers `"email": false`. An address gets an email with a link to confirm it, valid for a day (`POST /api/notifications/channels/<id>/confirm` sends a new one; an account sends at most 10 a day), and nothing else until the link is opened and its button pressed. Every email is plain text with a simple HTML part, no images or tracking, and carries an unsubscribe link (also as `List-Unsubscribe`, for a mail client's one-click unsubscribe) that removes the address without signing in. The links are under `<PUBLIC_URL>/api/email/` and the unsubscribe links are signed with `SESSION_SECRET`: changing it invalidates those already sent.

A channel set to get the daily digest (`"digest": true` when added, or with `PATCH`) receives, once a day, a summary of the account's reviews of the day before (UTC): how many, of how many pull requests, the counts by severity, the titles of up to five critical or warning findings still open when the account shares findings, and how many of the account's enrolled repositories' pull requests were merged, naming up to five, with links to the console. A day without reviews or merges sends nothing. The server checks every hour and the database records the day sent per account, so several processes on one database send it once. It needs `PUBLIC_URL`, which its links point to.

A channel set to get the weekly report (`"weekly": true` when added, or with `PATCH`) receives, once a week, a summary of the seven days before the account's report slot: a UTC weekday and hour, Monday 09:00 unless changed (`GET` and `PUT /api/notifications/report` with `{"weekday": 0–6, "hour": 0–23}`, Sunday being 0; the answer names the next slot). It holds the reviews and the pull requests they were of, the counts by severity, the findings later runs saw fixed or dismissed, and, when the account shares findings, how many of the week's findings are still open and the titles of up to five critical or warning ones; the pull requests merged, with the median time from opened to merged and the newest five; and the three repositories with the most reviews. A week without reviews or merges sends nothing. A slot is sent within a day after it, or not at all, and the database records the slot sent per account, so several processes send it once and a slot set mid-week waits for its next one. Like the digest, it needs `PUBLIC_URL`; the hosted Worker runs it from an hourly cron.

Merges come from the platforms' webhooks for enrolled repositories (see Auto review): GitHub's pull request `closed` event, through the App's webhook, and GitLab's merge request hook when a merge request is merged or closed. The server keeps one record per pull request (its title, whether it was merged, when it opened and when it closed; a later close after a reopen replaces it) for 90 days, like reviews, and the account's export holds them.
