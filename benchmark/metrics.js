/**
 * Pure metrics pipeline.
 *
 * All benchmark metrics are derived from the append-only event log — never
 * from counters the runner happened to maintain in memory. This makes every
 * number reproducible from raw artifacts alone.
 */

/** @typedef {import("./fixtures.js").MazeFixture} MazeFixture */

/**
 * @param {number[]} sortedValues ascending
 * @param {number} p in (0,1]
 */
export function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(p * sortedValues.length) - 1),
  );
  return sortedValues[index];
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Compute metrics for one episode from its event log.
 *
 * @param {Array<Record<string, unknown>>} events
 * @param {MazeFixture} fixture
 */
export function computeEpisodeMetrics(events, fixture) {
  const endEvent = events.find((event) => event.type === "episode_end");
  const moveEvents = events.filter((event) => event.type === "move");
  const turnEvents = events.filter((event) => event.type === "turn_start");
  const attempts = events.flatMap((event) =>
    event.type === "model_result" ? /** @type {any[]} */ (event.attempts) : [],
  );

  const successfulMoves = moveEvents.filter((event) => event.result === "moved").length;
  const wallHits = moveEvents.filter((event) => event.result === "blocked").length;
  // validActions: parsed decisions that passed direction validation and led to an attempted move.
  const validActions = moveEvents.length;
  const invalidResponses = countInvalidResponses(events);
  const apiFailures = endEvent?.status === "api_failure" ? 1 : 0;
  const retryAttempts = attempts.filter((attempt) => attempt.attempt > 1).length;
  const solved = endEvent?.status === "solved";
  const optimalPathLength = fixture.optimalPathLength;

  // pathEfficiency is defined ONLY for solved episodes; unsolved episodes
  // report null instead of a misleading percentage.
  const pathEfficiency = solved && successfulMoves > 0
    ? optimalPathLength / successfulMoves
    : null;
  const spl = solved && optimalPathLength > 0
    ? optimalPathLength / Math.max(optimalPathLength, successfulMoves)
    : 0;

  const latencies = attempts.map((attempt) => attempt.latencyMs ?? 0).sort((a, b) => a - b);
  const usage = aggregateUsage(attempts);

  return {
    fixtureId: fixture.fixtureId,
    status: endEvent?.status ?? "incomplete",
    reason: endEvent?.reason ?? null,
    solved: Boolean(solved),
    attemptedTurns: turnEvents.length,
    validActions,
    successfulMoves,
    wallHits,
    invalidResponses,
    apiFailures,
    retryAttempts,
    optimalPathLength,
    pathEfficiency,
    spl,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.length ? latencies[latencies.length - 1] : null,
      total: sum(latencies),
      samples: latencies.length,
    },
    tokens: usage,
  };
}

/**
 * Invalid responses are recorded per attempt with an invalid-output category.
 * Under policy v0.1, blocked-direction choices are wall hits, not invalid
 * responses.
 */
export function countInvalidResponses(events) {
  let count = 0;
  for (const event of events) {
    if (event.type !== "model_result") continue;
    for (const attempt of /** @type {any[]} */ (event.attempts)) {
      if (isInvalidOutputCategory(attempt.errorCategory)) count += 1;
    }
  }
  return count;
}

export function isInvalidOutputCategory(category) {
  return category === "refusal"
    || category === "invalid_structured_json"
    || category === "schema_violation";
}

/**
 * Aggregate token usage across attempts; provider raw payloads are preserved.
 *
 * @param {any[]} attempts
 */
function aggregateUsage(attempts) {
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let total = 0;
  const providerRaw = [];
  for (const attempt of attempts) {
    const usage = attempt.usage;
    if (!usage) continue;
    providerRaw.push(usage);
    input += usage.input_tokens ?? 0;
    output += usage.output_tokens ?? 0;
    reasoning += usage.output_tokens_details?.reasoning_tokens ?? 0;
    total += usage.total_tokens ?? 0;
  }
  return { inputTokens: input, outputTokens: output, reasoningTokens: reasoning, totalTokens: total, providerRaw };
}

/**
 * Batch-level latency percentiles over every recorded model attempt.
 *
 * @param {Array<Array<Record<string, unknown>>>} perEpisodeEvents
 */
export function computeBatchLatency(perEpisodeEvents) {
  const latencies = perEpisodeEvents
    .flatMap((events) => events)
    .filter((event) => event.type === "model_result")
    .flatMap((event) => /** @type {any[]} */ (event.attempts))
    .map((attempt) => attempt.latencyMs ?? 0)
    .sort((a, b) => a - b);
  return {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.length ? latencies[latencies.length - 1] : null,
    totalWallClockMs: sum(latencies),
    samples: latencies.length,
  };
}

/**
 * Compute batch-level aggregate metrics from per-episode metrics.
 *
 * @param {Array<Record<string, unknown>>} episodeMetrics
 */
export function computeBatchMetrics(episodeMetrics) {
  const total = episodeMetrics.length;
  const solvedEpisodes = episodeMetrics.filter((episode) => episode.solved);
  const solvedCount = solvedEpisodes.length;

  const meanSpl = total > 0
    ? sum(episodeMetrics.map((episode) => episode.spl ?? 0)) / total
    : null;
  const solvedOnlyEfficiencies = solvedEpisodes
    .map((episode) => episode.pathEfficiency)
    .filter((value) => typeof value === "number");
  const solvedOnlyPathEfficiency = solvedOnlyEfficiencies.length > 0
    ? sum(solvedOnlyEfficiencies) / solvedOnlyEfficiencies.length
    : null;

  const statusCounts = episodeMetrics.reduce((acc, episode) => {
    acc[episode.status] = (acc[episode.status] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));

  return {
    totalEpisodes: total,
    solved: solvedCount,
    successRate: total > 0 ? solvedCount / total : null,
    meanSpl,
    solvedOnlyPathEfficiency,
    totals: {
      attemptedTurns: sum(episodeMetrics.map((episode) => episode.attemptedTurns)),
      validActions: sum(episodeMetrics.map((episode) => episode.validActions)),
      successfulMoves: sum(episodeMetrics.map((episode) => episode.successfulMoves)),
      wallHits: sum(episodeMetrics.map((episode) => episode.wallHits)),
      invalidResponses: sum(episodeMetrics.map((episode) => episode.invalidResponses)),
      apiFailures: sum(episodeMetrics.map((episode) => episode.apiFailures)),
      retryAttempts: sum(episodeMetrics.map((episode) => episode.retryAttempts)),
      tokens: {
        inputTokens: sum(episodeMetrics.map((episode) => episode.tokens.inputTokens)),
        outputTokens: sum(episodeMetrics.map((episode) => episode.tokens.outputTokens)),
        reasoningTokens: sum(episodeMetrics.map((episode) => episode.tokens.reasoningTokens)),
        totalTokens: sum(episodeMetrics.map((episode) => episode.tokens.totalTokens)),
      },
    },
    statusCounts,
  };
}
