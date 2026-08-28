# DeepSeek V4 Flash 0731 — Live Run (policy v0.4, aborted)

Date: 2026-02 (local run)
Provider: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`)
Contract: benchmark v0, policy revision v0.4 (tolerant JSON extraction +
field-name normalization), timeout 180 s (raised from 90 s for slow
reasoning models).

## Context

First new model after luna/ox-alpha/Nemotron. Probe on turn 1 succeeded with
full navigation semantics. Initial attempt under the 90 s timeout died at
turn 2 on `invalid_api_response` (latency hit the ceiling); the timeout was
then raised to 180 s. This run (batch id `live-deepseek-v4-r2`) uses the
180 s timeout. Aborted by user at episode 5 of 10 (machine needed to be
freed); episodes 1–4 are complete.

## Result (4 completed episodes)

```
0/4 solved · 0.0% success
Failure modes: invalid_output ×2 (schema_violation), api_failure ×2
```

| Fixture | Status | Turns | Moves | Wall hits | Last category |
|---|---|---|---|---|---|
| v0-01 | invalid_output | 11 | 10 | 0 | schema_violation |
| v0-02 | api_failure | 17 | 16 | 0 | invalid_api_response (retry) |
| v0-03 | api_failure | 7 | 6 | 0 | missing_output |
| v0-04 | invalid_output | 9 | 8 | 0 | schema_violation |

## What we learned

1. **Strong navigator.** 4 episodes × 10–16 consecutive successful moves,
   zero wall hits, clearly converging on the exit (ep01 reached Manhattan
   distance 2 before dying; ep02 reached distance 6). In a v0.1 world where
   blocked-direction choices merely consume a turn, this model would have
   kept moving healthily — the runs died on output quality, not navigation.

2. **Long-context tail format degradation, twice.** ep01 turn 11 and ep04
   turn 9 both ended in `schema_violation` at 8–10 clean moves. ep01's raw
   attempt 2 echoed the prompt's own JSON-schema definition back as if it
   were the answer (context-copy failure). This is the pattern to watch:
   ~10 turns in, on a chatty long-context, DeepSeek starts emitting schema
   boilerplate or other malformed JSON instead of a decision.

3. **Sparse very-long turns.** per-turn latencies are mostly 3–18 s, but
   sparse turns burn the full 2000-token budget (~160 s in ep01 turn 7 —
   `incomplete_output`, rescued by the doubled-budget retry). Combined with
   a slow endpoint, this drags episodes to minutes each. Non-streamed
   end-to-end latency is nonetheless a deliberate measurement, not a bug.

4. **Endpoint flakiness again.** `invalid_api_response`, `missing_output`,
   and near-timeout latencies cut ep02/ep03 short — same provider-layer
   noise seen with ox-alpha and Nemotron free.

## Status vs. the field

| model | revision | solved | primary failure |
|---|---|---|---|
| openai/gpt-5.6-luna | v0.0 | 1/10 | wall-hit terminations; perfect schema compliance |
| stealth/ox-alpha | v0.0 | 0/10 | schema (reasoning → reasoning_summary) |
| stealth/ox-alpha | v0.4 | aborted | endpoint instability (format fixed) |
| nvidia/nemotron-…:free | v0.3 | 0/10 | endpoint instability (format fixed) |
| deepseek/deepseek-v4-flash-0731 | v0.4 | 0/4 (aborted) | schema echo at ~10 turns + endpoint noise |

## Raw artifacts

Transcripts, manifest, per-episode summaries: `artifacts/live-deepseek-v4-r2/`
(copied from the batch output).