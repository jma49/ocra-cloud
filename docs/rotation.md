# Rotating the master key

The master key (`MASTER_KEY`, a Worker secret) wraps each provider key's data key (`src/crypto.ts`). Rotating it re-wraps the data keys; the ciphertexts do not change, and the service keeps working throughout, because it decrypts with `MASTER_KEY` and falls back to `MASTER_KEY_PREVIOUS`.

1. Make the new key, kept apart from the old one: `openssl rand -base64 32 | tr -d '\n' > .local/master-key.new` (mode 0600).
2. Check, with no change: `node scripts/rewrap-master-key.ts --old .local/master-key --new .local/master-key.new`. Every row must open with the old key and verify with the new one.
3. Switch the Worker to both keys: `npx wrangler secret put MASTER_KEY_PREVIOUS < .local/master-key`, then `npx wrangler secret put MASTER_KEY < .local/master-key.new`. New keys are now wrapped with the new key; old rows still open with the previous one.
4. Re-wrap the stored rows: the same command with `--apply`, then run the check again with `--old .local/master-key.new --new .local/master-key` only if you need to roll back.
5. Remove the fallback: `npx wrangler secret delete MASTER_KEY_PREVIOUS`. Keep the old key file until a review through the gateway has worked, then destroy it, and replace `.local/master-key` with the new one (and the password manager's copy).

Each `UPDATE` matches the row's old wrapped key too, so a row written by the service in between (a key saved during the rotation, already wrapped with the new key) is left alone.
