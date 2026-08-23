# Echo Maze Benchmark — Policy v0.3/v0.4 Live Runs (Nemotron, ox-alpha)

Date: 2026-02 (local run)
Provider: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`)
Contract: benchmark v0, policy revisions v0.3 (token budget) and v0.4
(field-name normalization). Both runs used the tolerant JSON extraction from
v0.2.

## Context

The v0.0/v0.1 runs (see `v0-live-ox-alpha-and-luna.md`) showed that models
fail on answer-envelope formatting more than on navigation:

- stealth/ox-alpha: emitted `reasoning` instead of `reasoning_summary`
  (schema violation) and died by turn 3.
- gpt-5.6-luna: perfect schema compliance; terminated only when choosing
  visibly blocked directions (policy v0.1 turned those into wall hits).

Policy revisions made after those runs:

- v0.2: tolerant JSON extraction (direct parse → markdown fences → first
  complete brace-balanced object). Content is never altered.
- v0.3: max output tokens 900 → 2000; `finish_reason=length` responses are
  `incomplete_output` and retried once with a doubled budget.
- v0.4: unambiguous field aliases (`reasoning` → `reasoning_summary`,
  `believedPosition` → `believed_position`, ...) re-keyed before validation;
  canonical fields win, values are never invented.

## Batch: Nemotron 3 Ultra (free) — policy v0.3

Model: `nvidia/nemotron-3-ultra-550b-a55b:free`

```
0/10 solved · 0.0% success
Invalid responses 0 | API failures 10
Latency p50/p95/max 35,431 / 90,004 / 90,007 ms  (p95 hits the timeout ceiling)
Tokens input 471,571 · output 167,783 · reasoning 124,003 · total 639,354
```

| Fixture | Status | Turns | Moves |
|---|---|---|---|
| v0-01 | api_failure | 7 | 6 |
| v0-02 | api_failure | 18 | 17 |
| v0-03 | api_failure | 8 | 7 |
| v0-04 | api_failure | 15 | 14 |
| v0-05 | api_failure | 6 | 5 |
| v0-06 | api_failure | 22 | 21 |
| v0-07 | api_failure | 12 | 11 |
| v0-08 | api_failure | 4 | 3 |
| v0-09 | api_failure | 24 | 23 |
| v0-10 | api_failure | 4 | 3 |

Key finding: **the free endpoint, not the model, lost this benchmark.** Zero
format errors (v0.2/v0.3 fixed the earlier JSON truncation), zero wall hits,
but every episode was cut short by endpoint instability: malformed responses,
502s, and latencies up to the 90 s timeout. Episode v0-09 was navigating
cleanly (23/29 moves, no wall hits) when the endpoint died.

## Batch: stealth/ox-alpha — policy v0.4 (partial, aborted)

Model: `stealth/ox-alpha` — aborted at episode 7 on user request (endpoint
too unstable to be worth the run).

Completed episodes: 6/10, all `api_failure`:

| Fixture | Status | Turns | Moves | Last category |
|---|---|---|---|---|
| v0-01 | api_failure | 10 | 9 | invalid_api_response |
| v0-02 | api_failure | 3 | 2 | invalid_api_response |
| v0-03 | api_failure | 7 | 6 | invalid_api_response |
| v0-04 | api_failure | 4 | 3 | invalid_api_response |
| v0-05 | api_failure | 1 | 0 | 429 |
| v0-06 | api_failure | 1 | 0 | 429 |

Key finding: **v0.4 fixed ox-alpha's original failure mode** — schema
violations dropped from 10/10 (policy v0.1) to 0, and the model navigated up
to 10 turns. The remaining failures are pure provider instability on the
Stealth endpoint (malformed responses, 429s), not model behavior. Full
results are not comparable to the v0.1 run because of the endpoint noise.

## Takeaways

1. Format-tolerance policies (v0.2–v0.4) are effective and remove a large
   class of false negatives.
2. Live results are only as good as the provider endpoint. For these two
   providers, "0/10 via api_failure" is endpoint noise, not a navigation
   score. Paid endpoints or re-runs at stable times are needed for
   comparable numbers.
3. gpt-5.6-luna (1/10 solved under v0.1) remains the only model with a
   navigation signal so far; re-run it under v0.4 for a comparable baseline.

## Raw artifacts

- `artifacts/live-nemotron-v03/` — full transcripts, manifest, summary
- ox-alpha v0.4 transcripts were left in `results/live-ox-alpha-v04/` (local,
  gitignored) since the batch was aborted; per-episode summaries are captured
  in the table above.
