/**
 * Echo Maze Benchmark v0 sequential batch runner.
 *
 * Runs all 10 frozen fixtures in contract order, one episode at a time, with
 * full episode isolation (fresh adapter state and conversation per episode).
 * Every episode produces an append-only JSONL transcript; summaries are
 * regenerated from those raw artifacts.
 *
 * Usage:
 *   node benchmark/run-batch.js --dry-run [--out results/<dir>] [--resume <dir>]
 *   OPENAI_API_KEY=... node benchmark/run-batch.js [--model gpt-5.6-luna] [...]
 */

import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MODEL,
  MAX_TURNS,
  MODEL_ALLOWLIST,
  PROVIDERS,
  TIMEOUT_MS,
  contractDescriptor,
  sha256,
  stableStringify,
} from "./contract.js";
import { loadAllFixtures, verifyFixture } from "./fixtures.js";
import { runEpisode } from "./episode.js";
import { createOpenAIAdapter } from "./adapters/openai-adapter.js";
import { createOpenRouterAdapter } from "./adapters/openrouter-adapter.js";
import { createMockAdapter } from "./adapters/mock-adapter.js";
import { computeEpisodeMetrics } from "./metrics.js";
import { TERMINAL_STATUSES, regenerateSummary } from "./summarize.js";
import { inspectGitProvenance } from "./provenance.js";

const RESUME_MANIFEST_FIELDS = [
  "benchmarkId",
  "benchmarkVersion",
  "policyRevision",
  "generatorVersion",
  "observationVersion",
  "fixtureOrder",
  "modelAllowlist",
  "defaultModel",
  "maxTurns",
  "timeoutMs",
  "maxAttemptsPerTurn",
  "retryPolicy",
  "maxOutputTokensBase",
  "reasoningEffort",
  "coordinateSystem",
  "hiddenStatePolicy",
  "promptHash",
  "schemaHash",
  "rulesHash",
  "mode",
  "resultClass",
  "provider",
  "apiEndpoint",
  "modelRequested",
  "fixtureSetHash",
  "commit",
  "dirty",
  "sourceHash",
  "diffHash",
];

function parseArgs(argv) {
  const args = { dryRun: false, model: null, out: null, resume: null, provider: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--resume") args.resume = argv[++i];
    else if (argv[i] === "--provider") args.provider = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  const provider = args.provider ?? "openai";
  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider: ${provider} (known: ${Object.keys(PROVIDERS).join(", ")})`);
  }
  return args;
}

/**
 * @param {Record<string, unknown>} previous
 * @param {Record<string, unknown>} expected
 * @returns {string[]}
 */
export function resumeManifestMismatches(previous, expected) {
  return RESUME_MANIFEST_FIELDS.filter((field) =>
    stableStringify(previous[field]) !== stableStringify(expected[field]));
}

function readEvents(transcriptPath) {
  return readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function collectReturnedModels(batchDir, fixtures) {
  const models = new Set();
  for (const fixture of fixtures) {
    const transcriptPath = path.join(batchDir, "episodes", fixture.fixtureId, "transcript.jsonl");
    if (!existsSync(transcriptPath)) continue;
    for (const event of readEvents(transcriptPath)) {
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

function updateManifestModelIdentity(manifest, batchDir, fixtures) {
  const modelsReturned = collectReturnedModels(batchDir, fixtures);
  manifest.modelsReturned = modelsReturned;
  manifest.modelReturned = modelsReturned.length === 1 ? modelsReturned[0] : null;
}

function writeManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function runBatch(options = {}) {
  const dryRun = options.dryRun ?? false;
  const model = options.model ?? DEFAULT_MODEL;
  const provider = options.provider ?? "openai";

  if (!PROVIDERS[provider]) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  if (!MODEL_ALLOWLIST.includes(model)) {
    throw new Error(`Model "${model}" is not in the allowlist (${MODEL_ALLOWLIST.join(", ")}).`);
  }

  // Fail fast on any fixture drift before spending a single API call.
  const fixtures = await loadAllFixtures();
  const problems = fixtures.flatMap(verifyFixture);
  if (problems.length > 0) {
    throw new Error(`Fixture verification failed:\n${problems.join("\n")}`);
  }

  const batchId = options.batchId
    ?? `bench-${contractDescriptor().benchmarkVersion}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
  const batchDir = path.resolve(options.outDir ?? path.join("results", batchId));
  const manifestPath = path.join(batchDir, "manifest.json");
  const hasExistingManifest = existsSync(manifestPath);
  const existingManifest = hasExistingManifest
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : null;

  if (options.resume && !hasExistingManifest) {
    throw new Error(`Cannot resume ${batchDir}: manifest.json does not exist.`);
  }
  if (!options.resume && hasExistingManifest) {
    throw new Error(`Output directory already contains a manifest: ${batchDir}. Use --resume to continue it.`);
  }

  const provenance = inspectGitProvenance();
  if (!dryRun && (!provenance.gitAvailable || provenance.dirty)) {
    throw new Error(
      "Live benchmark runs require a clean git worktree with readable source provenance. "
      + "Commit or stash local changes before running the official benchmark.",
    );
  }
  if (!dryRun && !options.apiKey) {
    throw new Error(
      `Live runs require ${PROVIDERS[provider].apiKeyEnv}. Use --dry-run for offline pipeline validation.`,
    );
  }

  const expectedManifest = {
    batchId: options.resume ? existingManifest.batchId : (options.batchId ?? path.basename(batchDir)),
    ...contractDescriptor(),
    mode: dryRun ? "dry-run" : "live",
    resultClass: dryRun || options.commit ? "exploratory" : "official",
    provider,
    apiEndpoint: PROVIDERS[provider].endpoint,
    modelRequested: model,
    modelReturned: dryRun ? "mock-explorer" : null,
    modelsReturned: dryRun ? ["mock-explorer"] : [],
    commit: options.commit ?? provenance.commit,
    dirty: provenance.dirty,
    sourceHash: provenance.sourceHash,
    diffHash: provenance.diffHash,
    createdAt: Date.now(),
    timeoutMs: TIMEOUT_MS,
    maxTurns: MAX_TURNS,
    retryPolicy: contractDescriptor().retryPolicy,
    fixtureSetHash: sha256(fixtures.map((fixture) => [fixture.fixtureId, fixture.fixtureHash])),
    runtime: {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
  };

  let manifest;
  if (existingManifest) {
    const mismatches = resumeManifestMismatches(existingManifest, expectedManifest);
    if (mismatches.length > 0) {
      throw new Error(
        `Cannot resume ${batchDir}: manifest is incompatible for ${mismatches.join(", ")}. `
        + "Use a new output directory for a different model, provider, contract, or source.",
      );
    }
    // Resume keeps the original manifest metadata and never rewrites it from
    // the current command-line defaults before compatibility is established.
    manifest = existingManifest;
  } else {
    mkdirSync(path.join(batchDir, "episodes"), { recursive: true });
    manifest = expectedManifest;
    writeManifest(manifestPath, manifest);
  }

  const adapterFor = () => {
    if (dryRun) return createMockAdapter();
    if (provider === "openrouter") return createOpenRouterAdapter(options.apiKey, { model });
    return createOpenAIAdapter(options.apiKey, { model });
  };

  /** @type {Array<{ fixtureId: string, status: string, skipped: boolean }>} */
  const outcomes = [];
  for (const fixture of fixtures) {
    const episodeDir = path.join(batchDir, "episodes", fixture.fixtureId);
    const summaryPath = path.join(episodeDir, "episode-summary.json");

    // Resume / idempotency: terminal episodes are never re-run.
    if (existsSync(summaryPath)) {
      const previous = JSON.parse(readFileSync(summaryPath, "utf8"));
      if (TERMINAL_STATUSES.has(previous.status)) {
        console.log(`[${fixture.fixtureId}] skip (terminal: ${previous.status})`);
        outcomes.push({ fixtureId: fixture.fixtureId, status: previous.status, skipped: true });
        continue;
      }
    }

    mkdirSync(episodeDir, { recursive: true });
    const transcriptPath = path.join(episodeDir, "transcript.jsonl");
    // A non-terminal leftover means a crashed/interrupted episode: restart it
    // from scratch so transcripts stay append-only per attempt generation.
    writeFileSync(transcriptPath, "");

    console.log(`[${fixture.fixtureId}] start (optimal ${fixture.optimalPathLength})`);
    const startedAt = Date.now();
    const result = await runEpisode({
      fixture,
      maxTurns: manifest.maxTurns,
      adapter: adapterFor(),
      onEvent: (event) => appendFileSync(transcriptPath, `${JSON.stringify(event)}\n`),
    });
    const wallClockMs = Date.now() - startedAt;

    const events = readEvents(transcriptPath);
    const metrics = computeEpisodeMetrics(events, fixture);
    const episodeSummary = { ...result, wallClockMs, metrics };
    writeFileSync(path.join(episodeDir, "episode-summary.json"), `${JSON.stringify(episodeSummary, null, 2)}\n`);
    updateManifestModelIdentity(manifest, batchDir, fixtures);
    writeManifest(manifestPath, manifest);
    console.log(
      `[${fixture.fixtureId}] ${result.status} in ${result.turns} turns `
      + `(moves=${metrics.successfulMoves}, walls=${metrics.wallHits})`,
    );
    outcomes.push({ fixtureId: fixture.fixtureId, status: result.status, skipped: false });
  }

  updateManifestModelIdentity(manifest, batchDir, fixtures);
  writeManifest(manifestPath, manifest);
  const summary = await regenerateSummary(batchDir);
  console.log("\n" + summaryMarkdownHeader(summary));
  console.log(`Batch artifacts: ${batchDir}`);
  return { batchDir, summary, outcomes };
}

function summaryMarkdownHeader(summary) {
  const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
  const returnedModels = summary.modelsReturned?.length
    ? summary.modelsReturned.join(", ")
    : summary.modelReturned ?? "unknown";
  return [
    `${summary.modelRequested} → ${returnedModels} · Echo Maze ${summary.benchmarkVersion} [${summary.mode.toUpperCase()} · ${summary.resultClass}]`,
    `${summary.solved}/${summary.episodes.length} solved · ${percent(summary.successRate)} success`,
    `Mean SPL: ${round3(summary.meanSpl)} | Solved-only path efficiency: ${round3(summary.solvedOnlyPathEfficiency)}`,
    `Wall hits: ${summary.totals.wallHits} | Invalid responses: ${summary.totals.invalidResponses} | API failures: ${summary.totals.apiFailures}`,
    `Latency p50/p95/max: ${summary.latency.p50}/${summary.latency.p95}/${summary.latency.max} ms`,
    `Tokens: total ${summary.totals.tokens.totalTokens}`,
  ].join("\n");
}

function round3(value) {
  return value === null || value === undefined ? "null" : String(Math.round(value * 1000) / 1000);
}

// CLI entry point when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const provider = args.provider ?? "openai";
  const apiKeyEnv = PROVIDERS[provider].apiKeyEnv;
  runBatch({
    dryRun: args.dryRun,
    model: args.model ?? undefined,
    outDir: args.out ?? (args.resume ? path.resolve(args.resume) : undefined),
    provider,
    resume: Boolean(args.resume),
    apiKey: process.env[apiKeyEnv],
  }).then((result) => {
    const terminal = result.outcomes.every((outcome) => TERMINAL_STATUSES.has(outcome.status));
    if (!terminal) {
      console.error("ERROR: some episodes did not reach a terminal status.");
      process.exitCode = 1;
    }
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
