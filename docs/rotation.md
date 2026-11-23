# Rotating the master key

The master key (`MASTER_KEY`, a Worker secret, or an environment variable of a self-hosted server) wraps the data key of every sealed row (`src/crypto.ts`): model provider keys (`provider_keys`), the accounts' code platform tokens (`platform_links`), enrolled GitLab projects' own access tokens (`review_repos.access_token_*`) and notification channels' addresses (`notify_channels`, a Slack member's direct messages included). Rotating it re-wraps the data keys; the ciphertexts do not change, and the service keeps working throughout, because it decrypts with `MASTER_KEY` and falls back to `MASTER_KEY_PREVIOUS`.

1. Make the new key, kept apart from the old one: `openssl rand -base64 32 | tr -d '\n' > .local/master-key.new` (mode 0600).
2. Check, with no change: `node scripts/rewrap-master-key.ts --old .local/master-key --new .local/master-key.new`. It reports each table: rows to re-wrap, rows already under the new key, rows that failed. Every row must open with the old key (or already the new one) and verify with the new one.
3. Switch the Worker to both keys: `npx wrangler secret put MASTER_KEY_PREVIOUS < .local/master-key`, then `npx wrangler secret put MASTER_KEY < .local/master-key.new`. New rows are now sealed with the new key; old rows still open with the previous one.
4. Re-wrap the stored rows: the same command with `--apply`. It writes nothing when a row fails, writes in batches, then reads every table back and fails unless each row opens with the new key. Run it again until it does: a second run re-wraps only what is left. To roll back, run it with `--old .local/master-key.new --new .local/master-key`.
5. Remove the fallback: `npx wrangler secret delete MASTER_KEY_PREVIOUS`. Keep the old key file until a review through the gateway has worked, then destroy it, and replace `.local/master-key` with the new one (and the password manager's copy).

A self-hosted server (SQLite or Postgres) has the same tool in its image, `node dist/rewrap-master-key.mjs`, which reads `DATABASE_URL`, `MASTER_KEY` (new) and `MASTER_KEY_PREVIOUS` (old) from the server's environment: `docs/self-hosting.md`, Rotating the master key. Both tools run one core, `rotateMasterKey` over `SEALED_KINDS` in `src/crypto.ts`, so they check, re-wrap and read back every table alike.

Each row is re-wrapped with the binding the service opens it with (its account and its row, or its provider or platform), and each `UPDATE` matches the row's old wrapped key too, so a row written by the service in between (saved during the rotation, already under the new key) is left alone. Nothing a row seals, and neither key, is printed.
## Binding keys to their rows (#16)

Since #16 every provider key is sealed with additional data naming its account and provider (`keyBinding` in `src/crypto.ts`): a sealed key copied onto another account's or provider's row does not open. Keys stored before that are bound once:

1. Deploy the Worker (it opens bound keys, and unbound ones as a fallback).
2. `node scripts/bind-provider-keys.ts --master .local/master-key` checks every row and says how many are already bound, how many it would bind and how many fail. Nothing is written.
3. With 0 failed, run it again with `--apply`, then once more without: it must report 0 to bind.
4. Remove the unbound fallback from `decryptWithAny` and deploy. Done on 2026-10-04: every key on ocra Cloud is bound, and an unbound key no longer opens.

During a master-key rotation, rotate after binding (or bind with the current key first): `rewrap-master-key.ts` re-wraps bound rows with their binding.
