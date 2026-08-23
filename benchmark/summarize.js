/**
 * Rebuild benchmark summaries (summary.json + summary.md) purely from the raw
 * artifacts in a batch directory: manifest.json plus the per-episode
 * transcript.jsonl files under episodes/<fixtureId>/.
 *
 * This is the single source of summary truth — the same function is used at
 * the end of a batch run and by `npm run benchmark:summary -- <dir>` to prove
 * that summaries can always be regenerated from artifacts.
 *
 * Usage: node benchmark/summarize.js <batchDir>
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { BENCHMARK_VERSION } from "./contract.js";
import { loadFixture } from "./fixtures.js";
import { computeBatchLatency, computeBatchMetrics, computeEpisodeMetrics } from "./metrics.js";

const TERMINAL_STATUSES = new Set(["solved", "unsolved_max_turns", "invalid_output", "api_failure"]);

/**
 * @param {string} batchDir
 */
export async function loadBatch(batchDir) {
  const manifest = JSON.parse(await readFile(path.join(batchDir, "manifest.json"), "utf8"));
  const episodesDir = path.join(batchDir, "episodes");
  const entries = await readdir(episodesDir);
  /** @type {Array<{ fixtureId: string, events: Array<Record<string, unknown>> }>} */
  const episodes = [];
  for (const entry of entries.filter((name) => !name.startsWith("."))) {
    const transcriptPath = path.join(episodesDir, entry, "transcript.jsonl");
    const raw = await readFile(transcriptPath, "utf8").catch(() => null);
    if (raw === null) continue;
    const events = raw.split("\n").filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    episodes.push({ fixtureId: entry, events });
  }
  // Keep contract fixture order.
  const order = manifest.fixtureOrder ?? [];
  episodes.sort((a, b) => order.indexOf(a.fixtureId) - order.indexOf(b.fixtureId));
  return { manifest, episodes };
}

/**
 * Regenerate summary.json and summary.md inside the batch directory.
 *
 * @param {string} batchDir
 */
export async function regenerateSummary(batchDir) {
  const { manifest, episodes } = await loadBatch(batchDir);

  /** @type {Array<Record<string, unknown>>} */
  const episodeMetrics = [];
  for (const episode of episodes) {
    const fixture = await loadFixture(episode.fixtureId);
    episodeMetrics.push(computeEpisodeMetrics(episode.events, fixture));
  }

  const batch = computeBatchMetrics(episodeMetrics);
  const latency = computeBatchLatency(episodes.map((episode) => episode.events));
  const mode = manifest.mode ?? "live";

  const summary = {
    benchmarkId: "echo-maze-benchmark",
    benchmarkVersion: manifest.benchmarkVersion ?? BENCHMARK_VERSION,
    policyRevision: manifest.policyRevision ?? "v0.0",
    batchId: manifest.batchId,
    mode,
    provider: manifest.provider ?? "openai",
    liveApiCall: mode === "live",
    disclaimer: mode === "dry-run"
      ? "DRY-RUN with deterministic mock adapter; NOT a live gpt-5.6-luna result."
      : "Live OpenAI Responses API calls.",
    modelRequested: manifest.modelRequested,
    modelReturned: manifest.modelReturned ?? null,
    generatedAt: Date.now(),
    totalEpisodes: batch.totalEpisodes,
    solved: batch.solved,
    successRate: batch.successRate,
    meanSpl: batch.meanSpl,
    solvedOnlyPathEfficiency: batch.solvedOnlyPathEfficiency,
    latency,
    totals: batch.totals,
    statusCounts: batch.statusCounts,
    hashes: {
      fixtureSetHash: manifest.fixtureSetHash,
      promptHash: manifest.promptHash,
      schemaHash: manifest.schemaHash,
      rulesHash: manifest.rulesHash,
      commit: manifest.commit,
    },
    episodes: episodeMetrics,
  };

  await writeFile(
    path.join(batchDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  await writeFile(path.join(batchDir, "summary.md"), renderMarkdown(summary), "utf8");
  return summary;
}

/**
 * @param {Record<string, any>} summary
 */
function renderMarkdown(summary) {
  const s = summary;
  const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const num = (value) => value === null || value === undefined ? "n/a" : String(value);
  const lines = [];
  lines.push(`# Echo Maze Benchmark ${s.benchmarkVersion} (policy ${s.policyRevision})`);
  lines.push("");
  lines.push(`**${s.modelRequested} · Echo Maze ${s.benchmarkVersion}** (${s.provider})`);
  if (s.mode === "dry-run") lines.push("");
  if (s.mode === "dry-run") lines.push("> ⚠️ DRY-RUN (deterministic mock adapter) — not a live gpt-5.6-luna result.");
  lines.push("");
  lines.push(`${s.solved}/${s.totalEpisodes ?? s.episodes.length} solved · ${percent(s.successRate)} success`);
  lines.push("");
  lines.push(`- Mean SPL: ${num(s.meanSpl === null ? null : round(s.meanSpl))}`);
  lines.push(`- Solved-only path efficiency: ${num(s.solvedOnlyPathEfficiency === null ? null : round(s.solvedOnlyPathEfficiency))}`);
  lines.push(`- Wall hits: ${s.totals.wallHits}`);
  lines.push(`- Invalid responses: ${s.totals.invalidResponses}`);
  lines.push(`- API failures: ${s.totals.apiFailures}`);
  lines.push(`- Retry attempts: ${s.totals.retryAttempts}`);
  lines.push(`- Latency p50/p95/max: ${num(s.latency.p50)} / ${num(s.latency.p95)} / ${num(s.latency.max)} ms (wall-clock total ${num(s.latency.totalWallClockMs)} ms over ${s.latency.samples} attempts)`);
  lines.push(`- Token usage: input ${s.totals.tokens.inputTokens} · output ${s.totals.tokens.outputTokens} · reasoning ${s.totals.tokens.reasoningTokens} · total ${s.totals.tokens.totalTokens}`);
  lines.push("");
  lines.push("| Fixture | Status | Turns | Moves | Wall hits | Path eff | SPL | p50 ms | Tokens |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const episode of s.episodes) {
    lines.push([
      episode.fixtureId,
      episode.status,
      episode.attemptedTurns,
      episode.successfulMoves,
      episode.wallHits,
      episode.pathEfficiency === null ? "null" : round(episode.pathEfficiency),
      round(episode.spl),
      episode.latencyMs.p50 ?? "n/a",
      episode.tokens.totalTokens,
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  lines.push("");
  lines.push(`commit: \`${s.hashes.commit}\` · fixtureSetHash: \`${short(s.hashes.fixtureSetHash)}\` · promptHash: \`${short(s.hashes.promptHash)}\` · schemaHash: \`${short(s.hashes.schemaHash)}\` · rulesHash: \`${short(s.hashes.rulesHash)}\``);
  return lines.join("\n") + "\n";
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function short(hash) {
  return typeof hash === "string" && hash.length > 12 ? hash.slice(0, 12) : String(hash ?? "unknown");
}

export { TERMINAL_STATUSES };
