# Self-hosting ocra Cloud

The same API and web app as app.ocracloud.com, on Node with a SQLite file instead of Cloudflare Workers and D1. `src/node/` is the only code that differs: it opens libSQL, reads the client's address from the socket or a trusted proxy, keeps the rate limits in memory, runs the daily retention, and serves `web/dist`. `test-node/` runs the app this way in CI.

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
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes | Your own GitHub App's client; its callback URL is `<PUBLIC_URL>/api/auth/github/callback` |
| `MASTER_KEY` | yes | base64 of 32 random bytes (`openssl rand -base64 32`); wraps every stored key. Losing it loses them |
| `MASTER_KEY_PREVIOUS` | during a rotation | as on Workers (`docs/rotation.md`) |
| `SESSION_SECRET` | yes | signs the sign-in state cookie |
| `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` | to connect GitLab | a GitLab OAuth application (scope `read_api`); its redirect URI is `<PUBLIC_URL>/api/platforms/gitlab/callback` |
| `GITLAB_URL` | for a self-hosted GitLab | the instance, such as `https://gitlab.example.com`; `https://gitlab.com` when unset |
| `PUBLIC_URL` | behind a TLS proxy | the address people open, such as `https://ocra.example.com` |
| `TRUSTED_PROXY_HOPS` | behind a proxy | how many proxies in front append to `X-Forwarded-For` (1 for one TLS proxy); the login code limits count by the address read past them. 0, the socket's peer, when unset |
| `DATABASE_URL` | no | a libSQL URL; `file:/data/ocra-cloud.db` in the image |
| `PORT` | no | 8787 |
| `GATEWAY_DAILY_CALLS`, `REVIEW_DAILY_UPLOADS`, `REVIEW_MAX_FINDINGS`, `DEVICE_DAILY_CODES`, `DEVICE_DAILY_CODES_PER_NETWORK` | no | the Worker's defaults (`wrangler.jsonc`) |

Serve it over HTTPS: session cookies are `__Host-` cookies, which browsers keep only on secure origins.

## Limits of this first version

- One process: the rate limits live in its memory, so run one replica.
- Sign-in is through a GitHub App, so `GITHUB_CLIENT_ID` is required even where reviews run on GitLab.
- SQLite or a libSQL server only; Postgres is not supported yet.
- Back up the `/data` volume; there is no Time Travel as on D1.
