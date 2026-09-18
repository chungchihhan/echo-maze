# Live Jev Lab capture

Exploratory TypeSafe **Jev** run for Echo Maze Live Lab (`/?lab=1`).

- Provider: TypeSafe System One (`jev-latest`)
- Policy: code-owned relative `visited`; Choice candidates prefer unvisited open neighbors
- Maze: seeded `ECHO-MAZE-DEMO` / `DEMO01` (same stable seed as the Live Lab demo maze)
- Not an official EMZ benchmark batch; kept for integration evidence

## Result

| field | value |
| --- | --- |
| status | **won** |
| turns / successful moves | 51 / 51 |
| wall hits | 0 |
| visited relative cells | 45 |
| optimal path length | 37 |
| wall-clock | ~3.2 s for the full capture |

Artifacts:

- `artifacts/live-jev-lab/manifest.json`
- `artifacts/live-jev-lab/summary.json`
- `artifacts/live-jev-lab/transcript.jsonl`

Re-run:

```bash
node --env-file=.env.local benchmark/experiments/capture-jev-lab.mjs
```
