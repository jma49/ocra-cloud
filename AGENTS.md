# Agent rules for ocra Cloud

Read the private handoff (`../ocra-internal/handoff.md`) and ADR-0024 (`../ocra/docs/adr/0024-ocra-cloud.md`) first.

- **Isolation is the first rule.** Account data is read and written only through `scoped()` in `src/db/scoped.ts`. Code outside `src/db/` does not import the account tables. A new account table goes in `accountTables` and gets a case in `test/isolation.test.ts` (the test fails until it does). Read rows with its queries (`find`, `findOne`, `count`, `listNewest`, …), never by filtering a whole `list()` in JS; `insert` makes the id.
- **Never log a request or response body** of a model call, nor a key, token or secret. Secrets are Worker secrets (`wrangler secret put`, with no trailing newline in piped input), never in `wrangler.jsonc` or the repo.
- `src/contract/` is the engine's `@open-cr-agent/cloud-contract`, copied by `scripts/sync-contract.mjs` at the commit in `contract.lock`. Never edit it here: change the engine, merge, then sync (CI's `contract` job fails otherwise). Request shapes, limits, vocabularies and redaction come from it, not from local copies.
- **One boundary layer** (`src/http.ts`): a route reads its body only with `jsonBody(schema)` and `c.req.valid("json")` (the contract's schema where it has one), refuses only with `apiError(c, code)` (a contract `ErrorCode`, whose status is fixed in `ERROR_STATUS`), and answers with explicit projections (`reviewDto`, `memoryEntryDto`, ... typed with `satisfies`), never a spread of a database row. `test/boundary.test.ts` fails on a body read anywhere else.
- Schema change: edit `src/db/schema.ts`, run `npm run db:generate`, commit the migration. Never edit an applied migration.
- `compatibility_date` stays at or below what the test runtime supports (the pool's workerd); tests fail to start otherwise.
- Run `npm run verify > log; echo $?` before pushing, and read the exit code.
- Commit as the maintainer (`git -c user.name=jincheng_m -c user.email=majincheng990128@gmail.com`), with no AI attribution.
- Deploy with `npm run deploy` from the maintainer's logged-in machine; CI has no Cloudflare token.
