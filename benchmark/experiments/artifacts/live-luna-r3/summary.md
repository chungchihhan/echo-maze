# Echo Maze Benchmark v0

**openai/gpt-5.6-luna · Echo Maze v0** (openrouter)

1/10 solved · 10.0% success

- Mean SPL: 0.038
- Solved-only path efficiency: 0.382
- Wall hits: 0
- Invalid responses: 9
- API failures: 0
- Retry attempts: 5
- Latency p50/p95/max: 3327 / 4599 / 10181 ms (wall-clock total 929998 ms over 270 attempts)
- Token usage: input 1881727 · output 67868 · reasoning 21155 · total 1949595

| Fixture | Status | Turns | Moves | Wall hits | Path eff | SPL | p50 ms | Tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| echo-maze-bench-v0-01 | invalid_output | 8 | 7 | 0 | null | 0 | 3082 | 18523 |
| echo-maze-bench-v0-02 | solved | 68 | 68 | 0 | 0.382 | 0.382 | 3437 | 793909 |
| echo-maze-bench-v0-03 | invalid_output | 31 | 30 | 0 | null | 0 | 3305 | 178079 |
| echo-maze-bench-v0-04 | invalid_output | 8 | 7 | 0 | null | 0 | 3092 | 16610 |
| echo-maze-bench-v0-05 | invalid_output | 51 | 50 | 0 | null | 0 | 3432 | 467221 |
| echo-maze-bench-v0-06 | invalid_output | 32 | 31 | 0 | null | 0 | 3269 | 199764 |
| echo-maze-bench-v0-07 | invalid_output | 6 | 5 | 0 | null | 0 | 3513 | 10515 |
| echo-maze-bench-v0-08 | invalid_output | 25 | 24 | 0 | null | 0 | 3327 | 123246 |
| echo-maze-bench-v0-09 | invalid_output | 13 | 12 | 0 | null | 0 | 3028 | 38171 |
| echo-maze-bench-v0-10 | invalid_output | 23 | 22 | 0 | null | 0 | 3149 | 103557 |

commit: `96c966dd36c95053925056bc24579bf0d58584e7` · fixtureSetHash: `50d337e9c45c` · promptHash: `a9f979fd720e` · schemaHash: `0e94fdaa32bd` · rulesHash: `569d57de97ab`
