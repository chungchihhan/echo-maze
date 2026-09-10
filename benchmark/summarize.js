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

import { BENCHMARK_VERSION, ROUTE_LENGTH_TIERS } from "./contract.js";
import { loadFixture } from "./fixtures.js";
import { computeBatchLatency, computeBatchMetrics, computeEpisodeMetrics } from "./metrics.js";
import {
  BENCHMARK_ID,
  BENCHMARK_NAME,
  BENCHMARK_SHORT_NAME,
  BENCHMARK_THEME,
} from "../lib/benchmark-brand.js";

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
  // Keep this batch's generated fixture order.
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
  const modelsReturned = collectReturnedModels(episodes);
  const modelReturned = modelsReturned.length === 1
    ? modelsReturned[0]
    : modelsReturned.length > 1
      ? null
      : manifest.mode === "dry-run"
        ? manifest.modelReturned ?? null
        : null;

  /** @type {Array<Record<string, unknown>>} */
  const episodeMetrics = [];
  for (const episode of episodes) {
    const fixture = await loadFixture(batchDir, episode.fixtureId);
    episodeMetrics.push(computeEpisodeMetrics(episode.events, fixture));
  }

  const batch = computeBatchMetrics(episodeMetrics);
  const difficultyTiers = Object.fromEntries(
    ROUTE_LENGTH_TIERS.map((tier) => [
      tier.id,
      {
        label: tier.label,
        minRouteLength: tier.min,
        maxRouteLength: tier.max,
        ...computeBatchMetrics(episodeMetrics.filter((episode) => episode.difficultyTier === tier.id)),
      },
    ]),
  );
  const latency = computeBatchLatency(episodes.map((episode) => episode.events));
  const mode = manifest.mode ?? "live";

  const summary = {
    benchmarkId: manifest.benchmarkId ?? BENCHMARK_ID,
    benchmarkName: manifest.benchmarkName ?? BENCHMARK_NAME,
    benchmarkShortName: manifest.benchmarkShortName ?? BENCHMARK_SHORT_NAME,
    benchmarkTheme: manifest.benchmarkTheme ?? BENCHMARK_THEME,
    benchmarkVersion: manifest.benchmarkVersion ?? BENCHMARK_VERSION,
    policyRevision: manifest.policyRevision ?? "v0.0",
    batchId: manifest.batchId,
    suiteSeed: manifest.suiteSeed ?? null,
    mazesPerTier: manifest.mazesPerTier ?? null,
    mode,
    resultClass: manifest.resultClass ?? (mode === "dry-run" ? "exploratory" : "unknown"),
    provider: manifest.provider ?? "openai",
    liveApiCall: mode === "live",
    disclaimer: mode === "dry-run"
      ? "DRY-RUN with deterministic mock adapter; NOT a live gpt-5.6-luna result."
      : `Live ${manifest.provider ?? "configured provider"} API calls.`,
    modelRequested: manifest.modelRequested,
    modelReturned,
    modelsReturned,
    dirty: manifest.dirty ?? null,
    generatedAt: Date.now(),
    totalEpisodes: batch.totalEpisodes,
    recordedEpisodes: batch.recordedEpisodes,
    solved: batch.solved,
    successRate: batch.successRate,
    meanSpl: batch.meanSpl,
    solvedOnlyPathEfficiency: batch.solvedOnlyPathEfficiency,
    latency,
    totals: batch.totals,
    statusCounts: batch.statusCounts,
    difficultyTiers,
    hashes: {
      fixtureSetHash: manifest.fixtureSetHash,
      promptHash: manifest.promptHash,
      schemaHash: manifest.schemaHash,
      rulesHash: manifest.rulesHash,
      commit: manifest.commit,
      sourceHash: manifest.sourceHash ?? null,
      diffHash: manifest.diffHash ?? null,
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

function collectReturnedModels(episodes) {
  const models = new Set();
  for (const episode of episodes) {
    for (const event of episode.events) {
      if (event.type !== "model_result") continue;
      for (const attempt of event.attempts ?? []) {
        if (typeof attempt.modelReturned === "string" && attempt.modelReturned.length > 0) {
          models.add(attempt.modelReturned);
        }
      }
    }
  }
  return [...models].sort();
}

/**
 * @param {Record<string, any>} summary
 */
function renderMarkdown(summary) {
  const s = summary;
  const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const num = (value) => value === null || value === undefined ? "n/a" : String(value);
  const lines = [];
  lines.push(`# ${s.benchmarkShortName} ${s.benchmarkVersion} (policy ${s.policyRevision})`);
  lines.push("");
  lines.push(`> ${s.benchmarkName} · ${s.benchmarkTheme}`);
  lines.push("");
  const returnedModels = s.modelsReturned?.length
    ? s.modelsReturned.join(", ")
    : s.modelReturned ?? "unknown";
  lines.push(`**${s.modelRequested} → ${returnedModels} · EMZ ${s.benchmarkVersion}** (${s.provider})`);
  if (s.mode === "dry-run") lines.push("");
  if (s.mode === "dry-run") lines.push("> ⚠️ DRY-RUN (deterministic mock adapter) — not a live gpt-5.6-luna result.");
  lines.push("");
  lines.push(`${s.solved}/${s.totalEpisodes ?? s.episodes.length} solved · ${percent(s.successRate)} success`);
  if (s.suiteSeed) {
    lines.push(`Suite seed: \`${s.suiteSeed}\` · ${s.mazesPerTier} maze(s) per tier`);
  }
  lines.push("");
  lines.push(`- Mean SPL: ${num(s.meanSpl === null ? null : round(s.meanSpl))}`);
  lines.push(`- Solved-only path efficiency: ${num(s.solvedOnlyPathEfficiency === null ? null : round(s.solvedOnlyPathEfficiency))}`);
  lines.push(`- Wall hits: ${s.totals.wallHits}`);
  lines.push(`- Invalid responses: ${s.totals.invalidResponses}`);
  lines.push(`- API failures: ${s.totals.apiFailures}`);
  lines.push(`- Infrastructure interruptions: ${s.totals.infraInterruptions}`);
  lines.push(`- Retry attempts: ${s.totals.retryAttempts}`);
  lines.push(`- Request latency p50/p95/max: ${num(s.latency.p50)} / ${num(s.latency.p95)} / ${num(s.latency.max)} ms (request total ${num(s.latency.totalRequestLatencyMs)} ms over ${s.latency.samples} attempts)`);
  lines.push(`- Token usage: input ${s.totals.tokens.inputTokens} · output ${s.totals.tokens.outputTokens} · reasoning ${s.totals.tokens.reasoningTokens} · total ${s.totals.tokens.totalTokens}`);
  lines.push("");
  lines.push("## Results by difficulty");
  lines.push("");
  lines.push("| Tier | Optimal route | Solved | Success | Mean SPL |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const tier of Object.values(s.difficultyTiers ?? {})) {
    lines.push(`| ${tier.label} | ${tier.minRouteLength}–${tier.maxRouteLength} | ${tier.solved}/${tier.totalEpisodes} | ${percent(tier.successRate)} | ${num(tier.meanSpl === null ? null : round(tier.meanSpl))} |`);
  }
  lines.push("");
  lines.push("| Fixture | Tier | Status | Turns | Moves | Wall hits | Path eff | SPL | p50 ms | Tokens |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const episode of s.episodes) {
    lines.push([
      episode.fixtureId,
      episode.difficultyTier ?? "n/a",
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
  lines.push(`class: \`${s.resultClass}\` · commit: \`${s.hashes.commit}\` · dirty: \`${s.dirty ?? "unknown"}\` · sourceHash: \`${short(s.hashes.sourceHash)}\` · diffHash: \`${short(s.hashes.diffHash)}\` · fixtureSetHash: \`${short(s.hashes.fixtureSetHash)}\` · promptHash: \`${short(s.hashes.promptHash)}\` · schemaHash: \`${short(s.hashes.schemaHash)}\` · rulesHash: \`${short(s.hashes.rulesHash)}\``);
  return lines.join("\n") + "\n";
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function short(hash) {
  return typeof hash === "string" && hash.length > 12 ? hash.slice(0, 12) : String(hash ?? "unknown");
}

export { TERMINAL_STATUSES };
