/**
 * Headless benchmark episode state machine.
 *
 * Runs one Walker episode against one frozen fixture using an injected model
 * adapter. No browser, no React, no D1: every observable fact becomes an
 * append-only event, and all metrics are later derived from that event log.
 *
 * Event types:
 * - episode_start  { fixtureId, startedAt }
 * - turn_start     { turn, observation }          (narrow DTO only)
 * - model_result   { turn, attempts[], parsed|null, errorCategory|null }
 * - move           { turn, direction, result, from, to, relativePosition, won }
 * - episode_end    { status, reason, endedAt }
 *
 * Absolute `from`/`to` coordinates appear ONLY in forensic artifacts; they
 * never enter the prompt (the prompt gets the observation DTO + conversation).
 */

import { applyMove, getNeighbor, relativeDelta, samePoint, walkerObservation } from "../lib/maze/index.js";
import { fixtureCells } from "./fixtures.js";

/**
 * @param {object} options
 * @param {import("./fixtures.js").MazeFixture} options.fixture
 * @param {(request: { turn: number, observation: unknown, conversation: unknown[] }) =>
 *   Promise<{ attempts: unknown[], parsed: Record<string, unknown> | null,
 *             error: { category: string, message: string } | null }>} options.adapter
 * @param {number} [options.maxTurns]
 * @param {(event: Record<string, unknown>) => void} [options.onEvent]
 * @returns {Promise<{ status: "solved"|"unsolved_max_turns"|"invalid_output"|"api_failure"|"infra_interrupted",
 *                     reason: string, turns: number }>}
 */
export async function runEpisode({ fixture, adapter, maxTurns = 120, onEvent = () => {} }) {
  const cells = fixtureCells(fixture);
  let position = { ...fixture.start };
  /** @type {{ x: number, y: number }} */
  let relativePosition = { x: 0, y: 0 };
  let turn = 0;
  let lastAction = null;
  let lastResult = null;
  /** @type {Array<Record<string, unknown>>} */
  const conversation = [];

  emit(onEvent, {
    type: "episode_start",
    fixtureId: fixture.fixtureId,
    seedProvenance: fixture.seed,
    optimalPathLength: fixture.optimalPathLength,
    startedAt: Date.now(),
  });

  while (turn < maxTurns) {
    turn += 1;
    const observation = buildObservation(cells, fixture, position, lastAction, lastResult);
    emit(onEvent, { type: "turn_start", turn, observation });

    const result = await adapter({ turn, observation, conversation });
    const errorCategory = result.error?.category
      ?? (result.attempts.at(-1)?.errorCategory ?? null);

    emit(onEvent, {
      type: "model_result",
      turn,
      attempts: result.attempts,
      parsed: result.parsed,
      errorCategory,
    });

    if (!result.parsed) {
      const status = errorCategory === "infra_interrupted"
        ? "infra_interrupted"
        : errorCategory === "api_failure" ? "api_failure" : "invalid_output";
      const reason = result.error?.message ?? `No valid decision (category: ${errorCategory ?? "unknown"}).`;
      return end(onEvent, status, reason, turn);
    }

    const direction = /** @type {string} */ (result.parsed.direction);
    // Policy v0.1: a parsed direction that is visibly blocked is NOT a repair
    // opportunity and does not terminate the episode — it flows into
    // applyMove below as a normal attempted move with result "blocked"
    // (wall hit), consuming the turn exactly like any other attempt.

    conversation.push({
      turn,
      observation,
      observationSummary: result.parsed.observation_summary,
      reasoning: result.parsed.reasoning_summary,
      believedPosition: result.parsed.believed_position,
      coordinateNote: result.parsed.coordinate_note,
      direction,
      result: null,
    });

    const fromPosition = { ...position };
    const outcome = applyMove(cells, position, direction);
    const moved = outcome.result === "moved";
    position = outcome.position;
    lastAction = direction;
    lastResult = outcome.result;
    const delta = relativeDelta(direction, outcome.result);
    relativePosition = { x: relativePosition.x + delta.x, y: relativePosition.y + delta.y };
    const won = samePoint(position, fixture.exit);
    const lastEntry = conversation[conversation.length - 1];
    lastEntry.result = outcome.result;

    emit(onEvent, {
      type: "move",
      turn,
      direction,
      result: outcome.result,
      from: moved ? fromPosition : { ...position },
      to: { ...position },
      attemptedTarget: moved ? undefined : { ...getNeighbor(position, direction) },
      relativePosition: { ...relativePosition },
      won,
    });

    if (won) {
      return end(onEvent, "solved", "Exit reached.", turn);
    }
  }

  return end(onEvent, "unsolved_max_turns", `Turn budget of ${maxTurns} exhausted.`, turn);
}

function buildObservation(cells, fixture, position, lastAction, lastResult) {
  return walkerObservation(cells, fixture.exit, position, lastAction, lastResult);
}

function end(onEvent, status, reason, turn) {
  emit(onEvent, { type: "episode_end", status, reason, turns: turn, endedAt: Date.now() });
  return { status, reason, turns: turn };
}

function emit(onEvent, event) {
  onEvent(event);
}
