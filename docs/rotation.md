# Rotating the master key

The master key (`MASTER_KEY`, a Worker secret) wraps each provider key's data key (`src/crypto.ts`). Rotating it re-wraps the data keys; the ciphertexts do not change, and the service keeps working throughout, because it decrypts with `MASTER_KEY` and falls back to `MASTER_KEY_PREVIOUS`.

1. Make the new key, kept apart from the old one: `openssl rand -base64 32 | tr -d '\n' > .local/master-key.new` (mode 0600).
2. Check, with no change: `node scripts/rewrap-master-key.ts --old .local/master-key --new .local/master-key.new`. Every row must open with the old key and verify with the new one.
3. Switch the Worker to both keys: `npx wrangler secret put MASTER_KEY_PREVIOUS < .local/master-key`, then `npx wrangler secret put MASTER_KEY < .local/master-key.new`. New keys are now wrapped with the new key; old rows still open with the previous one.
4. Re-wrap the stored rows: the same command with `--apply`, then run the check again with `--old .local/master-key.new --new .local/master-key` only if you need to roll back.
5. Remove the fallback: `npx wrangler secret delete MASTER_KEY_PREVIOUS`. Keep the old key file until a review through the gateway has worked, then destroy it, and replace `.local/master-key` with the new one (and the password manager's copy).

Each `UPDATE` matches the row's old wrapped key too, so a row written by the service in between (a key saved during the rotation, already wrapped with the new key) is left alone.

## Binding keys to their rows (#16)

Since #16 every provider key is sealed with additional data naming its account and provider (`keyBinding` in `src/crypto.ts`): a sealed key copied onto another account's or provider's row does not open. Keys stored before that are bound once:

1. Deploy the Worker (it opens bound keys, and unbound ones as a fallback).
2. `node scripts/bind-provider-keys.ts --master .local/master-key` checks every row and says how many are already bound, how many it would bind and how many fail. Nothing is written.
3. With 0 failed, run it again with `--apply`, then once more without: it must report 0 to bind.
4. Remove the unbound fallback from `decryptWithAny` and deploy. Done on 2026-10-04: every key on ocra Cloud is bound, and an unbound key no longer opens.

During a master-key rotation, rotate after binding (or bind with the current key first): `rewrap-master-key.ts` re-wraps bound rows with their binding.
