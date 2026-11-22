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
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | one way to sign in | Your own GitHub App's client; its callback URL is `<PUBLIC_URL>/api/auth/github/callback` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | one way to sign in | An OpenID Connect provider: the company's SSO (Keycloak, Azure AD, Okta) or a self-hosted GitLab, which is one. A confidential client with the scopes `openid profile email` and the redirect URI `<PUBLIC_URL>/api/auth/oidc/callback`; the issuer is the URL its discovery document names, such as `https://gitlab.example.com` |
| `OIDC_NAME` | no | the provider's name on the sign-in button, "SSO" when unset |
| `MASTER_KEY` | yes | base64 of 32 random bytes (`openssl rand -base64 32`); wraps every stored key. Losing it loses them |
| `MASTER_KEY_PREVIOUS` | during a rotation | as on Workers (`docs/rotation.md`) |
| `SESSION_SECRET` | yes | signs the sign-in state cookie |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | to connect GitLab | a GitLab OAuth application (scope `read_api`); its redirect URI is `<PUBLIC_URL>/api/platforms/gitlab/callback` |
| `GITLAB_URL` | for a self-hosted GitLab | the instance, such as `https://gitlab.example.com`; `https://gitlab.com` when unset |
| `PUBLIC_URL` | behind a TLS proxy | the address people open, such as `https://ocra.example.com` |
| `TRUSTED_PROXY_HOPS` | behind a proxy | how many proxies in front append to `X-Forwarded-For` (1 for one TLS proxy); the login code limits count by the address read past them. 0, the socket's peer, when unset |
| `MODEL_ENDPOINTS` | for company models | the company's own OpenAI-compatible model endpoints, as JSON (Company models below) |
| `DEFAULT_MODELS` | no | the default models, as JSON (`{"top": ["ocra-corp/qwen3-coder"], "light": "ocra-corp/qwen3-8b"}`), that an account starts with until it saves its own; each must be one the gateway serves |
| `BUILTIN_PROVIDERS` | no | `off` forwards to `MODEL_ENDPOINTS` only, never to the public providers; `on` when unset |
| `GITHUB_WEBHOOK_SECRET` | for GitHub code graphs | your GitHub App's webhook secret; the App's webhook URL is `<PUBLIC_URL>/api/graphs/webhooks/github`, subscribed to push events. GitHub pushes are refused without it |
| `GRAPH_WORKERS` | no | code graph builds a process runs at once, each of another repository; 1 when unset |
| `CODE_GRAPH` | no | what the server does with code graphs: `keep` (the default), `opt-in` (only for repositories added with the owner's consent) or `off` (none kept; the daily retention deletes any that are) |
| `DATABASE_URL` | no | a Postgres server's `postgres://user:password@host:5432/db`, or a libSQL URL: `file:/data/ocra-cloud.db` in the image, or a libSQL server's |
| `RATE_LIMITS` | with several processes | `database` counts the rate limits in the database, so that each holds for the deployment; `memory`, per process, when unset |
| `MIGRATE` | with several processes | `on` (the default) applies the migrations at start, `off` leaves them, `only` applies them and exits |
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

An account adds a repository under `/api/graphs/repos`; the server then keeps a graph of its default branch (symbol names, kinds and line numbers per file, never code), built after each push from the platform's tree and blob APIs with the account's own token, reading only the files that changed. Pushes arrive at `<PUBLIC_URL>/api/graphs/webhooks/github` (the GitHub App's webhook, signed with its secret) or `/api/graphs/webhooks/gitlab` (a project hook with the secret the server answers when the project is added). Builds older than 14 days are deleted daily, except each repository's newest; an account purges a repository's graphs or removes it at any time. Builds run in the server process with the engine's tree-sitter parser (`@open-cr-agent/code-graph`); with several processes on one database, each build is claimed by one of them. `PUBLIC_URL` must be set for GitLab, whose token refresh names the server's address.

## Limits of this first version

- Set GitHub, OpenID Connect or both; the server refuses to start with neither. An account belongs to the identity it signed in with: the same person through GitHub and through SSO is two accounts.
- Back up the `/data` volume, or the Postgres database; there is no Time Travel as on D1.
