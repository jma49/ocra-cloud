# Reconciling usage with the provider

ocra Cloud records every model call it makes or forwards with an account's keys: hosted reviews, replies, learnings, generated tests and docs, fixes, Ask ocra, CI explanations, and calls that failed, timed out or were cancelled. Each `gateway_calls` row keeps the provider's own token counts from the answer (the whole prompt, the part read from the prompt cache, the parts written to the five-minute and one-hour caches, and the output) and what they cost at the model's list price (`cost_micro_usd`, millionths of a dollar, with the `price_version` of `src/model-prices.ts` it was counted at). A model without a price is recorded as unpriced (`cost_micro_usd` null), shown as such, and never counted as free. Counting a prompt's tokens (`/v1/messages/count_tokens`) is free and is recorded as using none.

The Usage page shows a calendar month by UTC day and model, and downloads it as a CSV (`GET /api/ledger/csv?month=YYYY-MM`, a web session). Insights' Spend is the same ledger summed by UTC day. The spend limits still count what reviews report (`maxCostUsd` in the CLI and `usage_counters` kind `spend`).

## What the provider sees that ocra Cloud does not

The provider bills a key, not ocra Cloud. Whatever else uses the same key is on its bill and not in the ledger: the CLI run on a laptop with the key, CI jobs (the engine's `eval-compare` and `eval-ab` workflows use `ANTHROPIC_API_KEY`), other tools. Give ocra Cloud a key of its own, and each other use its own, so the provider's usage can be filtered to ocra Cloud's key and the two agree.

## Comparing a month

1. In the Claude Console, open Usage, choose the month, and export the usage as CSV with the API key and model shown. The script reads the columns by name (`usage_date_utc`, `model`, `api_key`, `usage_input_tokens_no_cache`, `usage_input_tokens_cache_write_5m`, `usage_input_tokens_cache_write_1h`, `usage_input_tokens_cache_read`, `usage_output_tokens`, or the Usage and Cost API's field names) and says which it could not find.
2. On ocra Cloud's Usage page, pick the same month under Spend by day and download the CSV.
3. Run, with the name the Console gives ocra Cloud's key:

   ```sh
   node scripts/reconcile-usage.ts --provider console.csv --ocra ocra-usage-2026-11.csv --api-key "ocra cloud"
   ```

   It prints each UTC day and model whose tokens differ, each kind as `provider-ocra=difference`, and what the difference costs at list prices; then how many rows differ and the total. It exits 0 when every row agrees, 1 when some differ, and 2 when a file cannot be read. `--all` prints the rows that agree too. Without `--api-key` every key in the export is counted.

A difference on a day is usually another use of the key. Rows from before the ledger kept the cache split are unpriced and count their whole prompt as uncached input. Claude Haiku 5.5 costs more for a prompt over 100K tokens; the ledger prices each call at its own rate, the script prices a difference at the short-prompt rate.
