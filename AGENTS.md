# Agent rules for ocra Cloud

Read the private handoff (`../ocra-internal/handoff.md`) and [ADR-0024](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0024-ocra-cloud.md) first. The engine's AGENTS.md (`../ocra/AGENTS.md`, or [on GitHub](https://github.com/jma49/Open-CR-Agent/blob/main/AGENTS.md)) is the house style for what this file does not say (module size, comments, tests).

- **Isolation is the first rule.** Account data is read and written only through `scoped()` in `src/db/scoped.ts`. Code outside `src/db/` does not import the account tables (`test/shared-boundary.test.ts`). A new account table goes in `accountTables` and gets a case in `test/isolation.test.ts` (the test fails until it does). Read rows with its queries (`find`, `findOne`, `count`, `listNewest`, …), never by filtering a whole `list()` in JS; `insert` makes the id.
- **Never log a request or response body** of a model call, nor a key, token or secret. Secrets are Worker secrets (`wrangler secret put`, with no trailing newline in piped input), never in `wrangler.jsonc` or the repo.
- The contract is the engine's `@open-cr-agent/cloud-contract`, an exact dependency (Dependabot offers no major). A shape changes in the engine, is released, then the pin is bumped here. Request shapes, limits, vocabularies, redaction and fixtures come from it, not from local copies.
- **One boundary layer** (`src/http.ts`): a route reads its body only with `jsonBody(schema)` and `c.req.valid("json")` (the contract's schema where it has one), refuses only with `apiError(c, code)` (a contract `ErrorCode`, whose status is fixed in `ERROR_STATUS`), and answers with explicit projections (`reviewDto`, `memoryEntryDto`, ... typed with `satisfies`), never a spread of a database row. `test/boundary.test.ts` fails on a body read anywhere else.
- **The web imports `src/` only from `src/shared/`**, never `src/db/` or the Worker's code; `src/shared/` imports only itself and the contract package; both take only the contract's types (`import type`), never its values, which bring zod into the web bundle (`test/shared-boundary.test.ts`). A name of the form `ocra-<provider>/<model>` is taken apart and made only with `parseModelId` and `formatModelId`.
- Schema change: edit `src/db/schema.ts`, run `npm run db:generate`, commit both migrations (`migrations/` for D1 and SQLite, `migrations-pg/` for Postgres; `test-node/postgres-schema.test.ts` fails when they differ). Never edit an applied migration.
- **Every query runs on D1, SQLite and Postgres:** what they write differently goes through `src/db/dialect.ts`; the `postgres` test project runs `test/` on PGlite.
- `compatibility_date` stays at or below what the test runtime supports (the pool's workerd); tests fail to start otherwise.
- Deploy as Working with agents says, with `npm run deploy` on a machine logged in to Cloudflare (CI has no token): it builds the web, applies remote D1 migrations, then deploys. `npx wrangler d1 migrations list ocra-cloud --remote` shows what it will apply; CI already runs `wrangler deploy --dry-run`. Afterwards check `/api/health`.

## Git and handoff

- Work on a branch `<type>/<short-kebab-description>` in its own worktree; open a pull request; merge by rebase once CI is green. `main` is not protected (private repository on the Free plan), so this is on you.
- [Conventional Commits](https://www.conventionalcommits.org/), committed as the maintainer (`git -c user.name=jincheng_m -c user.email=majincheng990128@gmail.com`); CI's `commits` job checks both and refuses AI attribution.
- Run `npm run verify` before pushing and read its exit code.
- Never commit `.dev.vars`, keys or other secrets. Update `../ocra-internal/handoff.md` at the end of a batch of work, as Working with agents says.

## Working with agents

Mirrored word for word in the AGENTS.md of ocra, ocra-cloud and ocra-site: change all three together. Each repository's AGENTS check compares this section's SHA-256 with the one it expects and keeps the file under 150 lines.

- **One owner per issue queue, one worktree per session.** Never edit a checkout another session is using.
- **Agents deploy ocra-site and ocra-cloud,** only committed `origin/main` with green CI, from a clean temporary worktree, with the repository's `npm run deploy`. Before a deploy that applies D1 migrations, record a Time Travel bookmark (`npx wrangler d1 time-travel info ocra-cloud`). Afterwards check the live result and report what went out: commit, migrations, bookmark.
- **The maintainer keeps** secret-store changes, account, billing and plan settings, and production database writes outside migrations: prepare the exact command, then hand off.
- **A critical Dependabot alert is a P0:** fix or pin it the same day.
- **Validate what you act on, after normalising it** (`new URL()`, path resolution), never only the raw input.
- **Uniqueness and currency live in the database** (`UNIQUE`, `ON CONFLICT`, compare-and-set), never in check-then-write code.
- **A fix's test fails on the old code on an assertion,** not on a module the fix adds (in ocra, `scripts/fails-without.sh` refuses that).
- **Shapes the CLI and ocra Cloud share live in `@open-cr-agent/cloud-contract`;** never retype them.
- **Show only what exists:** mocks, demos and the landing use shipped behaviour and recorded or synthetic data, never the maintainer's accounts, numbers, keys or budget.
- **Private notes are for maintainers** with access to `jma49/ocra-internal` (`../ocra-internal`): `git pull --rebase` before editing it, commit and push right after, rebase on a conflict. A session without write access puts its handoff in its final report instead.
- **Keep AGENTS.md under 150 lines:** a rule a check enforces names that check; stories go to `../ocra-internal/pitfalls.md`.
