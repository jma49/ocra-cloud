# Agent rules for ocra Cloud

Read the private handoff (`../ocra-internal/handoff.md`) and [ADR-0024](https://github.com/jma49/Open-CR-Agent/blob/main/docs/adr/0024-ocra-cloud.md) first. The engine's AGENTS.md is the house style for what this file does not say (module size, comments, tests).

- **Isolation is the first rule.** Account data is read and written only through `scoped()` in `src/db/scoped.ts`. Code outside `src/db/` does not import the account tables. A new account table goes in `accountTables` and gets a case in `test/isolation.test.ts` (the test fails until it does). Read rows with its queries (`find`, `findOne`, `count`, `listNewest`, …), never by filtering a whole `list()` in JS; `insert` makes the id.
- **Never log a request or response body** of a model call, nor a key, token or secret. Secrets are Worker secrets (`wrangler secret put`, with no trailing newline in piped input), never in `wrangler.jsonc` or the repo.
- `src/contract/` is the engine's `@open-cr-agent/cloud-contract`, copied by `scripts/sync-contract.mjs` at the commit in `contract.lock`. Never edit it here: change the engine, merge, then sync (CI's `contract` job fails otherwise). Request shapes, limits, vocabularies and redaction come from it, not from local copies.
- **One boundary layer** (`src/http.ts`): a route reads its body only with `jsonBody(schema)` and `c.req.valid("json")` (the contract's schema where it has one), refuses only with `apiError(c, code)` (a contract `ErrorCode`, whose status is fixed in `ERROR_STATUS`), and answers with explicit projections (`reviewDto`, `memoryEntryDto`, ... typed with `satisfies`), never a spread of a database row. `test/boundary.test.ts` fails on a body read anywhere else.
- **The web imports `src/` only from `src/shared/` and `src/contract/`**, never `src/db/` or the Worker's code; `src/shared/` imports only itself and the contract; both take only the contract's types, never its values, which bring zod into the web bundle (`test/shared-boundary.test.ts`). A name of the form `ocra-<provider>/<model>` is taken apart and made only with `parseModelId` and `formatModelId`.
- Schema change: edit `src/db/schema.ts`, run `npm run db:generate`, commit the migration. Never edit an applied migration.
- `compatibility_date` stays at or below what the test runtime supports (the pool's workerd); tests fail to start otherwise.
- Deploy with `npm run deploy` from the maintainer's logged-in machine; CI has no Cloudflare token.

## Git and handoff

- Work on a branch `<type>/<short-kebab-description>` in its own worktree; open a pull request; merge by rebase once CI is green. `main` is not protected (private repository on the Free plan), so this is on you.
- [Conventional Commits](https://www.conventionalcommits.org/), committed as the maintainer (`git -c user.name=jincheng_m -c user.email=majincheng990128@gmail.com`); CI's `commits` job checks both and refuses AI attribution.
- Run `npm run verify > log; echo $?` before pushing, and read the exit code.
- Never commit `.dev.vars`, keys or other secrets. Update `../ocra-internal/handoff.md` at the end of a batch of work.

## Working with agents

Mirrored word for word in the AGENTS.md of ocra, ocra-cloud and ocra-site: change all three together.

- **One owner per issue queue, one worktree per session.** Never edit a checkout another session is using.
- **The maintainer runs production:** deploys, production database writes and secret-store changes. Prepare the exact command and a dry-run result, then hand off.
- **A critical Dependabot alert is a P0:** fix or pin it the same day.
- **Validate what you act on, after normalising it** (`new URL()`, path resolution), never only the raw input.
- **Uniqueness and currency live in the database** (`UNIQUE`, `ON CONFLICT`, compare-and-set), never in check-then-write code.
- **A fix's test fails on the old code on an assertion,** not on a module the fix adds (`scripts/fails-without.sh` refuses that).
- **Shapes the CLI and ocra Cloud share live in `@open-cr-agent/cloud-contract`;** never retype them.
- **Show only what exists:** mocks, demos and the landing use shipped behaviour and recorded or synthetic data, never the maintainer's accounts, numbers, keys or budget.
- **Keep AGENTS.md under 150 lines:** a rule names the check that enforces it; stories go to `../ocra-internal/pitfalls.md`.
