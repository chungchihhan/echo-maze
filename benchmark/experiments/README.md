# Echo Maze Benchmark v0 — Experiment Log

Live evaluation runs against the Echo Maze Solo-Walker benchmark, executed
through OpenRouter. This is the reference ledger for model results, policy
revisions, and the failure modes we observed. Pair each entry with the
policy revision in effect so results are comparable only within the same
revision.

Contract: `benchmark/contract.js` (benchmark `v0`). Fixtures are frozen
snapshots under `benchmark/fixtures/` (10 episodes, maze size 9, optimal
path 24–44 moves). Raw transcripts/manifests/summaries live under
`benchmark/experiments/artifacts/`.

Per-batch notes: `v0-live-ox-alpha-and-luna.md`,
`v03-v04-nemotron-oxalpha.md`.

---

## Policy revisions

| Rev | What changed | Why |
|---|---|---|
| v0.0 strict | (baseline) blocked-direction choice terminates as invalid | initial contract |
| v0.1 | blocked direction = wall hit (episode continues) | measure real navigation, not luck |
| v0.2 | tolerant JSON extraction (fences / first balanced object) | models wrap JSON in prose |
| v0.3 | max output tokens 900 → 2000; `length` responses = retryable | verbose reasoning truncated JSON |
| v0.4 | field-name alias normalization (no content invention) | `reasoning` → `reasoning_summary` etc. |

Timeout raised 90 s → 180 s (benchmark param) for slow reasoning models.

---

## Live results by model

| model | revision | result | primary failure mode |
|---|---|---|---|
| stealth/ox-alpha | v0.0 | 0/10 | schema violations (all 9; died by turn 3) |
| openai/gpt-5.6-luna | v0.0 | 1/10 | wall-hit terminations; only model with perfect schema compliance |
| nvidia/nemotron-3-ultra-550b-a55b:free | v0.3 | 0/10 | endpoint instability (`api_failure` 10/10) — model navigated fine |
| stealth/ox-alpha | v0.4 | aborted (partial) | schema violations 0 (format fixed); steady-endpoint `invalid_api_response` |
| deepseek/deepseek-v4-flash-0731 | v0.4 | aborted (4/10) | schema echo at ~10 turns, sparse long turns, endpoint noise |

---

## Failure-mode taxonomy (what actually ended episodes)

**1. Schema violations — answer content shape, not navigation.**
- ox-alpha (v0.0): `reasoning` instead of `reasoning_summary`, 9/10.
- Fixed by v0.4 alias normalization.
- DeepSeek ep01: the model echoed the prompt's own JSON-schema definition
  back as if it were the answer (context-copy failure at long context).

**2. Endpoint instability / transport.**
- 429s (rate limit), `502`, `invalid_api_response` (200 body unparsable),
  extreme latencies near the 90 s timeout.
- Dominated ox-alpha (Stealth) and Nemotron free; not model behavior.

**3. JSON truncation (max-output-token exhaustion).**
- Text beyond the budget cut the JSON short; token reasoning preamble
  ("thoughts") ate the budget.
- Addressed by v0.3 raise + retry; DeepSeek still shows sparse
  `incomplete_output` (once 160 s burn).

**4. Long-context tail format degradation (DeepSeek).**
- ~10 clean moves in, the model echoed the prompt's own JSON-schema
  definition as if it were the answer (ep01 t11, ep04 t9). Not navigation
  failure — format collapse at long context. Watch for this in any
  chatty reasoning model.

**4. Slow reasoning models + non-streamed measurement.**
Many DeepSeek turns return in 3–18 s, but sparse turns burn the full
budget (a 160 s `incomplete_output` occurred). pi feels instant because it
streams; this benchmark deliberately measures end-to-end non-streamed
latency. Latency is a real model-quality signal, not a harness bug.

---

## Takeaways

1. **Format-tolerance policies (v0.2–v0.4) remove large numbers of false
   negatives** and should be the baseline for any provider.
2. **Live results are only as good as the endpoint.** "0/10 via
   `api_failure`" for Nemotron free / ox-alpha is endpoint noise, not a
   navigation score. Prefer paid endpoints or stable windows.
3. **DeepSeek V4 Flash (0731) is a strong navigator but a slow,
   format-degrading one.** Long-context tail degradation (schema echo at
   turn 11 on ep01) is a real, recorded failure mode to watch across
   episodes.
4. **gpt-5.6-luna remains the only model with a solved episode** under
   the strict v0.x contract so far.
5. **DeepSeek V4 Flash (0731) is a strong navigator but weak on long
   context.** 0/4 aborted: every episode died at ~8–16 clean moves on
   schema echo / endpoint noise, never on navigation.

## Open questions

- Does DeepSeek reliably crash at ~10+ turns (schema echo) or was ep01 an
  outlier? (ep02 passes turn 14 → outlier; ep04 t9 suggests real tail risk.)
- Re-run gpt-5.6-luna under v0.4 for a comparable baseline.
- Paid Nemotron (`nvidia/nemotron-3-ultra-550b-a55b`, no `:free`) to remove
  endpoint noise.