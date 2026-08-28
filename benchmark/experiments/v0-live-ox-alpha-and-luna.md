# Echo Maze Benchmark v0 — Live Experiment Record

Date: 2026-02 (local run)
Provider: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`)
Contract: benchmark v0, strict policy revision `v0.0` (a visibly blocked
direction choice terminates the episode as invalid output; no repair).

## Batches

| Batch | Model | Result | Artifacts |
|---|---|---|---|
| `live-ox-alpha` | stealth/ox-alpha | 0/10 solved | `artifacts/live-ox-alpha/` |
| `live-luna-r1` | openai/gpt-5.6-luna | aborted: OpenRouter 429 rate limit (no backoff) | removed |
| `live-luna-r2` | openai/gpt-5.6-luna | 0/10 — 9× api_failure (429), backoff too short | removed |
| `live-luna-r3` | openai/gpt-5.6-luna | **1/10 solved** | `artifacts/live-luna-r3/` |

## Results: stealth/ox-alpha (v0 strict policy)

```
0/10 solved · 0.0% success · Mean SPL 0 · Latency p50/p95/max 8806/10266/12278 ms
Tokens total 28,216 · Invalid responses 10 · API failures 0
```

Failure modes: 9 episodes died on schema violations (model emitted a
`reasoning` field instead of the required `reasoning_summary`), 1 episode died
on choosing a visibly blocked direction. Longest survival: 3 turns.

## Results: openai/gpt-5.6-luna (v0 strict policy)

```
1/10 solved · 10.0% success
Mean SPL 0.038 | Solved-only path efficiency 0.382
Wall hits 0 | Invalid responses 9 | API failures 0
Latency p50/p95/max 3327/4599/10181 ms
Tokens input 1,881,727 · output 67,868 · reasoning 21,155 · total 1,949,595
OpenRouter key usage after all runs: ~$0.47
```

Per-episode:

| Fixture | Status | Turns | Moves | SPL |
|---|---|---|---|---|
| v0-01 | invalid_output (blocked dir "up") | 8 | 7 | 0 |
| v0-02 | **solved** | 68 | 68 | 0.382 |
| v0-03 | invalid_output (blocked dir "left") | 31 | 30 | 0 |
| v0-04 | invalid_output (blocked dir "down") | 8 | 7 | 0 |
| v0-05 | invalid_output (blocked dir "left") | 51 | 50 | 0 |
| v0-06 | invalid_output (blocked dir "left") | 32 | 31 | 0 |
| v0-07 | invalid_output (blocked dir) | 6 | 5 | 0 |
| v0-08 | invalid_output (blocked dir) | 25 | 24 | 0 |
| v0-09 | invalid_output (blocked dir) | 13 | 12 | 0 |
| v0-10 | invalid_output (blocked dir) | 23 | 22 | 0 |

## Findings

1. **stealth/ox-alpha fails structured-output compliance**: it writes valid
   JSON but with wrong field names (`reasoning` instead of
   `reasoning_summary`). It never survives past turn 3, so its navigation
   ability is unmeasurable under this contract.
2. **gpt-5.6-luna has perfect schema compliance but weak direction validity**:
   9/10 episodes survived 6–51 turns and then chose a direction that the same
   turn's observation listed as blocked. The observation summaries frequently
   described the wall correctly right before violating it — consistent with
   degraded instruction-following over long conversations rather than lack of
   spatial understanding.
3. Under the v0 strict policy, "chose a visibly blocked direction" zeroes out
   an otherwise competent run. This motivated policy revision `v0.1`.
4. Operational notes: OpenRouter rate limits required exponential backoff
   honoring Retry-After (20s base for 429) plus 2.5 s inter-request pacing.
   The model ignores OpenRouter `response_format: json_schema`; explicit
   JSON-only instructions in OUTPUT_FRAMING are required for compliance.

## Policy revision v0.1 (this repository)

A parsed decision that names a visibly blocked direction is now recorded as a
wall hit: the walker stays in place and the turn is consumed, but the episode
continues. The behavior stays fully visible in metrics (`wallHits`) and in
transcripts; there is no retry or repair within the turn. Schema violations
and refusals still terminate the episode as `invalid_output`.

## Raw artifacts

- `manifest.json`, `episodes/<fixtureId>/transcript.jsonl`, `summary.md` per batch.
- Live batches were run under contract v0 / policy v0.0; results are not
  directly comparable to future v0.1 runs.
