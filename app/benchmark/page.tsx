import type { Metadata } from "next";
import Link from "next/link";
import replayIndex from "../../public/replay-data/index.json";
import { SiteHeader } from "../site-header";

export const metadata: Metadata = {
  title: "Benchmark Results — Echo Maze",
  description: "Compare how AI agents navigate the same hidden mazes using observation and memory.",
};

type PublishedRun = {
  id: string;
  status: string;
  model: string;
  maze_seed: string;
  max_turn: number | null;
  spl?: number;
  batch_id?: string;
  reasoning_effort?: string | null;
};

type Tier = "easy" | "medium" | "hard";

type ModelResult = {
  key: string;
  model: string;
  effort: string;
  runs: PublishedRun[];
  solved: number;
  averageSpl: number;
  reliableRuns: number;
};

const TIERS: Tier[] = ["easy", "medium", "hard"];

function suiteName(run: PublishedRun) {
  return run.batch_id?.split("--")[0] ?? "published-suite";
}

function tierFor(run: PublishedRun): Tier {
  return TIERS.find((tier) => run.maze_seed.includes(`-${tier}-`)) ?? "easy";
}

function modelName(model: string) {
  return model.split("/").at(-1) ?? model;
}

function providerName(model: string) {
  return model.includes("/") ? model.split("/")[0] : "model";
}

function statusLabel(status: string) {
  if (status === "unsolved_max_turns") return "Unsolved · max turns";
  return status.replaceAll("_", " ");
}

function groupResults(runs: PublishedRun[]) {
  const groups = new Map<string, PublishedRun[]>();
  for (const run of runs) {
    const effort = run.reasoning_effort ?? "default";
    const key = `${run.model}::${effort}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  return [...groups.entries()]
    .map(([key, modelRuns]): ModelResult => {
      const solved = modelRuns.filter((run) => run.status === "solved").length;
      const averageSpl = modelRuns.reduce((total, run) => total + (run.spl ?? 0), 0) / modelRuns.length;
      const reliableRuns = modelRuns.filter((run) => !["invalid_output", "api_failure"].includes(run.status)).length;
      return {
        key,
        model: modelRuns[0].model,
        effort: modelRuns[0].reasoning_effort ?? "default",
        runs: [...modelRuns].sort((a, b) => {
          const tierDifference = TIERS.indexOf(tierFor(a)) - TIERS.indexOf(tierFor(b));
          return tierDifference || a.maze_seed.localeCompare(b.maze_seed);
        }),
        solved,
        averageSpl,
        reliableRuns,
      };
    })
    .sort((a, b) => b.solved - a.solved || b.averageSpl - a.averageSpl || b.reliableRuns - a.reliableRuns);
}

export default function BenchmarkPage() {
  const runs = replayIndex.runs as PublishedRun[];
  const suites = [...new Set(runs.map(suiteName))];
  const activeSuite = suites[0] ?? "published-suite";
  const suiteRuns = runs.filter((run) => suiteName(run) === activeSuite);
  const results = groupResults(suiteRuns);
  const mazeCount = new Set(suiteRuns.map((run) => run.maze_seed)).size;

  return (
    <main className="echo-app public-shell benchmark-page">
      <SiteHeader active="benchmark" />

      <section className="benchmark-hero" aria-labelledby="benchmark-title">
        <div>
          <p className="eyebrow">EMZ BENCHMARK · MEMORY IN MOTION</p>
          <h1 id="benchmark-title">Memory,<br /><em>measured.</em></h1>
        </div>
        <div className="benchmark-hero-copy">
          <p>Every model enters the same hidden mazes with the same rules. The only way out is to observe, remember, and move.</p>
          <span>Results from published, replayable runs.</span>
        </div>
      </section>

      <section className="benchmark-suite" aria-label="Benchmark suite">
        <div className="benchmark-suite-name">
          <span>SUITE</span>
          <strong>{activeSuite}</strong>
        </div>
        <dl>
          <div><dt>MODELS</dt><dd>{results.length}</dd></div>
          <div><dt>MAZES</dt><dd>{mazeCount}</dd></div>
          <div><dt>RUNS</dt><dd>{suiteRuns.length}</dd></div>
          <div><dt>PROTOCOL</dt><dd>v0.8 · low effort</dd></div>
        </dl>
      </section>

      <section className="benchmark-results" aria-labelledby="results-title">
        <div className="benchmark-results-head">
          <div>
            <p className="eyebrow">LEADERBOARD</p>
            <h2 id="results-title">Same maze.<br />Different memory.</h2>
          </div>
          <p>Ranked by solve rate, then path efficiency. Open the Replay workspace to inspect every recorded decision.</p>
        </div>

        <div className="benchmark-scoreboard">
          {results.map((result, index) => {
            const solveRate = Math.round(result.solved / result.runs.length * 100);
            return (
              <article className="benchmark-model-row" key={result.key}>
                <div className="benchmark-rank" aria-label={`Rank ${index + 1}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                </div>
                <header className="benchmark-model-name">
                  <span>{providerName(result.model)}</span>
                  <h3>{modelName(result.model)}</h3>
                  <small>reasoning · {result.effort}</small>
                </header>
                <div className="benchmark-primary-score">
                  <strong>{solveRate}<sup>%</sup></strong>
                  <span>{result.solved} of {result.runs.length} solved</span>
                </div>
                <div className="benchmark-tier-scores">
                  {TIERS.map((tier) => {
                    const tierRuns = result.runs.filter((run) => tierFor(run) === tier);
                    const tierSolved = tierRuns.filter((run) => run.status === "solved").length;
                    return (
                      <div key={tier}>
                        <span>{tier}</span>
                        <strong>{tierSolved}<small>/{tierRuns.length}</small></strong>
                      </div>
                    );
                  })}
                </div>
                <div className="benchmark-secondary-scores">
                  <div><span>AVG SPL</span><strong>{result.averageSpl.toFixed(3)}</strong></div>
                  <div><span>VALID RUNS</span><strong>{result.reliableRuns}/{result.runs.length}</strong></div>
                </div>
                <div className="benchmark-run-evidence">
                  <span>RUN EVIDENCE</span>
                  <div>
                    {result.runs.map((run) => (
                      <Link
                        className={`benchmark-run-dot status-${run.status.replaceAll("_", "-")}`}
                        href={`/replay?run=${encodeURIComponent(run.id)}`}
                        key={run.id}
                        aria-label={`${run.maze_seed}: ${statusLabel(run.status)}`}
                        title={`${run.maze_seed} · ${statusLabel(run.status)}`}
                      >
                        <span>{run.maze_seed.match(/(easy|medium|hard)-(\d+)$/)?.[2] ?? "·"}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <div className="benchmark-legend" aria-label="Run status legend">
          <span><i className="status-solved" />Solved</span>
          <span><i className="status-unsolved-max-turns" />Unsolved · max turns</span>
          <span><i className="status-invalid-output" />Invalid output</span>
          <span><i className="status-api-failure" />API failure</span>
        </div>
      </section>

      <footer className="benchmark-footer">
        <span>Scores summarize outcomes. Replays show the decisions.</span>
        <Link href="/replay">Open Replay workspace <span aria-hidden="true">↗</span></Link>
      </footer>
    </main>
  );
}
