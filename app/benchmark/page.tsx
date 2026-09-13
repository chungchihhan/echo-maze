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
  successful_moves?: number;
  wall_hits?: number;
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
  scoredRuns: number;
  solved: number;
  averageSpl: number;
  medianSolvedTurns: number | null;
  wallHitsPer100: number;
  formatCompletion: number;
  apiFailures: number;
};

const TIERS: Tier[] = ["easy", "medium", "hard"];
const UNSCORED_STATUSES = new Set(["infra_interrupted", "infrastructure_interrupted"]);

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

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function MetricHelp({ label, children }: { label: string; children: string }) {
  return (
    <span className="benchmark-metric-help">
      <button type="button" aria-label={`About ${label}`}>?</button>
      <span role="tooltip">{children}</span>
    </span>
  );
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
      const scoredRuns = modelRuns.filter((run) => !UNSCORED_STATUSES.has(run.status));
      const solvedRuns = scoredRuns.filter((run) => run.status === "solved");
      const formatRuns = scoredRuns.filter((run) => run.status !== "api_failure");
      const moveAttempts = modelRuns.reduce((total, run) => total + (run.successful_moves ?? 0) + (run.wall_hits ?? 0), 0);
      const wallHits = modelRuns.reduce((total, run) => total + (run.wall_hits ?? 0), 0);
      return {
        key,
        model: modelRuns[0].model,
        effort: modelRuns[0].reasoning_effort ?? "default",
        runs: [...modelRuns].sort((a, b) => {
          const tierDifference = TIERS.indexOf(tierFor(a)) - TIERS.indexOf(tierFor(b));
          return tierDifference || a.maze_seed.localeCompare(b.maze_seed);
        }),
        scoredRuns: scoredRuns.length,
        solved: solvedRuns.length,
        averageSpl: scoredRuns.length > 0
          ? scoredRuns.reduce((total, run) => total + (run.spl ?? 0), 0) / scoredRuns.length
          : 0,
        medianSolvedTurns: median(solvedRuns.flatMap((run) => typeof run.max_turn === "number" ? [run.max_turn] : [])),
        wallHitsPer100: moveAttempts > 0 ? wallHits / moveAttempts * 100 : 0,
        formatCompletion: formatRuns.length > 0
          ? formatRuns.filter((run) => run.status !== "invalid_output").length / formatRuns.length * 100
          : 0,
        apiFailures: modelRuns.filter((run) => run.status === "api_failure").length,
      };
    })
    .sort((a, b) => {
      const aSolveRate = a.scoredRuns > 0 ? a.solved / a.scoredRuns : 0;
      const bSolveRate = b.scoredRuns > 0 ? b.solved / b.scoredRuns : 0;
      return bSolveRate - aSolveRate || b.averageSpl - a.averageSpl || b.formatCompletion - a.formatCompletion;
    });
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
          <details className="benchmark-column-toggle">
            <summary>
              <span className="benchmark-toggle-more">More metrics</span>
              <span className="benchmark-toggle-less">Fewer metrics</span>
              <i aria-hidden="true" />
            </summary>
          </details>
          {results.map((result, index) => {
            const solveRate = result.scoredRuns > 0 ? Math.round(result.solved / result.scoredRuns * 100) : 0;
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
                  <span>{result.solved} of {result.scoredRuns} scored</span>
                </div>
                <div className="benchmark-tier-scores">
                  {TIERS.map((tier) => {
                    const tierRuns = result.runs.filter((run) => tierFor(run) === tier && !UNSCORED_STATUSES.has(run.status));
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
                  <div>
                    <div className="benchmark-metric-label">
                      <span>AVG SPL</span>
                      <MetricHelp label="average SPL">Success weighted by path efficiency. A score of 1.0 means every scored maze was solved using an optimal path.</MetricHelp>
                    </div>
                    <strong>{result.averageSpl.toFixed(3)}</strong>
                  </div>
                  <div className="benchmark-extra-metric">
                    <div className="benchmark-metric-label">
                      <span>MEDIAN TURNS</span>
                      <MetricHelp label="median turns">The median number of turns used by solved runs. Lower is faster, but maze routes vary in length.</MetricHelp>
                    </div>
                    <strong>{result.medianSolvedTurns ?? "—"}</strong>
                  </div>
                  <div className="benchmark-extra-metric">
                    <div className="benchmark-metric-label">
                      <span>WALL HITS / 100</span>
                      <MetricHelp label="wall hits per 100">Blocked moves per 100 recorded move attempts across all runs.</MetricHelp>
                    </div>
                    <strong>{result.wallHitsPer100.toFixed(1)}</strong>
                  </div>
                  <div className="benchmark-extra-metric">
                    <div className="benchmark-metric-label">
                      <span>FORMAT</span>
                      <MetricHelp label="format completion">Share of non-API-failure runs that completed without an invalid structured response.</MetricHelp>
                    </div>
                    <strong>{Math.round(result.formatCompletion)}%</strong>
                  </div>
                  <div className="benchmark-extra-metric">
                    <div className="benchmark-metric-label">
                      <span>API FAILURES</span>
                      <MetricHelp label="API failures">Runs terminated by an unresolved provider or transport failure.</MetricHelp>
                    </div>
                    <strong>{result.apiFailures}</strong>
                  </div>
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
