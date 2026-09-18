/** @typedef {"up"|"right"|"down"|"left"} Direction */

/**
 * TypeSafe System One (Jev) client for Echo Maze move Choice.
 * Kept separate from the Vercel AI SDK text-generation boundary.
 */

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-latest";

/** @type {Record<Direction, { x: number, y: number }>} */
export const RELATIVE_DELTAS = {
  up: { x: 0, y: 1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
};

/**
 * @param {{ x: number, y: number }} point
 */
export function relativeKey(point) {
  return `${point.x},${point.y}`;
}

/**
 * @param {{ x: number, y: number }} point
 * @param {Direction} direction
 */
export function relativeNeighbor(point, direction) {
  const delta = RELATIVE_DELTAS[direction];
  return { x: point.x + delta.x, y: point.y + delta.y };
}

/**
 * Prefer open directions that enter an unvisited relative cell.
 * When every open neighbor is visited, allow full open set (forced backtrack).
 *
 * @param {Direction[]} openDirections
 * @param {{ x: number, y: number }} relativePosition
 * @param {Iterable<string>} visitedKeys
 */
export function preferUnvisitedDirections(openDirections, relativePosition, visitedKeys) {
  const visited = visitedKeys instanceof Set ? visitedKeys : new Set(visitedKeys);
  const open = [...new Set(openDirections)];
  const fresh = open.filter((direction) => !visited.has(relativeKey(relativeNeighbor(relativePosition, direction))));
  return fresh.length > 0 ? fresh : open;
}

/**
 * Reconstruct visited relative cells from the run conversation.
 *
 * @param {Array<{
 *   estimatedPosition?: { x: number, y: number } | null,
 *   action?: Direction | null,
 *   result?: "moved"|"blocked"|null,
 * }>} conversation
 * @param {{ x: number, y: number }} currentPosition
 */
export function buildVisitedKeys(conversation, currentPosition) {
  const visited = new Set([relativeKey({ x: 0, y: 0 }), relativeKey(currentPosition)]);
  for (const turn of conversation ?? []) {
    const position = turn?.estimatedPosition;
    if (position && Number.isInteger(position.x) && Number.isInteger(position.y)) {
      visited.add(relativeKey(position));
      if (turn.result === "moved" && turn.action && RELATIVE_DELTAS[turn.action]) {
        visited.add(relativeKey(relativeNeighbor(position, turn.action)));
      }
    }
  }
  return visited;
}

/**
 * @param {{
 *   apiKey: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 * }} config
 */
export function createTypeSafeClient(config) {
  if (!config.apiKey) throw new Error("TYPESAFE_AI_API_KEY (or TYPESAFE_API_KEY) is required.");
  const fetchImpl = config.fetchImpl ?? fetch;
  const model = config.model ?? DEFAULT_MODEL;

  return {
    /**
     * Ask Jev to pick the next open direction.
     *
     * @param {{
     *   state: Record<string, unknown>,
     *   openDirections: Direction[],
     *   timeoutMs?: number,
     * }} request
     */
    async chooseDirection(request) {
      const openDirections = [...new Set(request.openDirections)];
      if (openDirections.length === 0) {
        return {
          ok: false,
          error: {
            category: "invalid_request",
            message: "No open directions available for a TypeSafe Choice.",
            retryable: false,
          },
        };
      }

      if (openDirections.length === 1) {
        const only = openDirections[0];
        return {
          ok: true,
          data: {
            choice: only,
            probabilities: Object.fromEntries(
              openDirections.map((direction) => [direction, direction === only ? 1 : 0]),
            ),
            confidence: 1,
            source: "deterministic",
          },
          meta: {
            model,
            requestId: null,
            responseId: null,
            status: "completed",
            latencyMs: 0,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
      }

      /** @type {Record<string, string>} */
      const criteria = {};
      for (const direction of openDirections) {
        criteria[direction] = directionCriteria(direction, request.state);
      }

      const timeoutMs = request.timeoutMs ?? 30_000;
      const startedAt = Date.now();
      let response;
      try {
        response = await fetchImpl(TYPESAFE_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            state: request.state,
            questions: {
              next_move: {
                type: "choice",
                instructions: [
                  "You are navigating a hidden maze toward an exit.",
                  "Choose the single best next move among the candidate directions provided.",
                  "Prefer a direction that shows the exit in line of sight.",
                  "Otherwise prefer corridors that continue farther or branch into new open directions.",
                  "The candidate list is already filtered by code to favor unvisited relative cells when any exist.",
                  "Use only the provided observation, relative position, visited cells, and recent turn history.",
                ].join(" "),
                criteria,
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error
          && (error.name === "TimeoutError" || error.name === "AbortError");
        return {
          ok: false,
          error: {
            category: timedOut ? "timeout" : "network_error",
            message: timedOut
              ? `TypeSafe request timed out after ${timeoutMs / 1000} seconds.`
              : "Could not reach the TypeSafe API.",
            retryable: true,
            meta: emptyMeta(model, startedAt),
          },
        };
      }

      const requestId = response.headers.get("x-request-id");
      let body;
      try {
        body = await response.json();
      } catch {
        return {
          ok: false,
          error: {
            category: "invalid_api_response",
            message: "TypeSafe returned an unreadable response.",
            retryable: response.status >= 500,
            meta: {
              ...emptyMeta(model, startedAt),
              requestId,
              status: String(response.status),
            },
          },
        };
      }

      const meta = {
        model: typeof body?.model === "string" ? body.model : model,
        requestId,
        responseId: null,
        status: response.ok ? "completed" : String(response.status),
        latencyMs: Date.now() - startedAt,
        usage: normalizeUsage(body?.usage),
      };

      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 409
          || response.status === 429 || response.status === 529 || response.status >= 500;
        return {
          ok: false,
          error: {
            category: response.status === 401 ? "authentication_error" : `http_${response.status}`,
            message: typeSafeErrorMessage(body, response.status),
            retryable,
            meta,
          },
        };
      }

      const answer = body?.answers?.next_move;
      const choice = answer?.choice;
      if (typeof choice !== "string" || !openDirections.includes(/** @type {Direction} */ (choice))) {
        return {
          ok: false,
          error: {
            category: "invalid_structured_json",
            message: "TypeSafe did not return a valid open direction Choice.",
            retryable: true,
            meta,
            rawOutput: JSON.stringify(answer ?? null).slice(0, 240),
          },
        };
      }

      /** @type {Record<string, number>} */
      const probabilities = {};
      for (const direction of openDirections) {
        const value = answer?.probabilities?.[direction];
        probabilities[direction] = typeof value === "number" ? value : 0;
      }

      return {
        ok: true,
        data: {
          choice: /** @type {Direction} */ (choice),
          probabilities,
          confidence: typeof answer?.confidence === "number" ? answer.confidence : 0,
          source: "typesafe",
        },
        meta,
      };
    },
  };
}

/**
 * @param {Direction} direction
 * @param {Record<string, unknown>} state
 */
function directionCriteria(direction, state) {
  const observation = asRecord(state.currentObservation);
  const relativePosition = asRecord(state.relativePosition);
  const visitedKeys = new Set(
    Array.isArray(state.visitedRelativeKeys)
      ? state.visitedRelativeKeys.filter((value) => typeof value === "string")
      : [],
  );
  const sightlines = Array.isArray(observation?.sightlines) ? observation.sightlines : [];
  const sight = sightlines.find((item) => asRecord(item)?.direction === direction);
  const sightRecord = asRecord(sight);
  const exitAlong = Array.isArray(sightRecord?.cells)
    && sightRecord.cells.some((cell) => asRecord(cell)?.isExit === true);
  const distance = typeof sightRecord?.distanceToWall === "number"
    ? sightRecord.distanceToWall
    : null;

  const parts = [`Move ${direction}.`];
  if (
    relativePosition
    && Number.isInteger(relativePosition.x)
    && Number.isInteger(relativePosition.y)
  ) {
    const next = relativeNeighbor(
      { x: /** @type {number} */ (relativePosition.x), y: /** @type {number} */ (relativePosition.y) },
      direction,
    );
    const seen = visitedKeys.has(relativeKey(next));
    parts.push(seen
      ? `Leads to already visited relative cell (${next.x}, ${next.y}).`
      : `Leads to unvisited relative cell (${next.x}, ${next.y}).`);
  }
  if (exitAlong) parts.push("The exit is visible along this corridor.");
  if (distance !== null) parts.push(`Open corridor continues for ${distance} cell(s) before a wall.`);
  parts.push("Only choose this if it is the best exploration or exit-seeking step.");
  return parts.join(" ");
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function normalizeUsage(usage) {
  const record = asRecord(usage);
  return {
    input_tokens: typeof record?.input_tokens === "number" ? record.input_tokens : null,
    output_tokens: typeof record?.output_tokens === "number" ? record.output_tokens : null,
  };
}

function emptyMeta(model, startedAt) {
  return {
    model,
    requestId: null,
    responseId: null,
    status: null,
    latencyMs: Date.now() - startedAt,
    usage: { input_tokens: null, output_tokens: null },
  };
}

function typeSafeErrorMessage(body, status) {
  if (typeof body?.detail === "string") return body.detail;
  if (typeof body?.message === "string") return body.message;
  if (typeof body?.error === "string") return body.error;
  if (body?.error && typeof body.error.message === "string") return body.error.message;
  return `TypeSafe request failed with status ${status}.`;
}

/**
 * Build a short notes string from Choice probabilities for conversation continuity.
 *
 * @param {{
 *   choice: string,
 *   probabilities: Record<string, number>,
 *   confidence: number,
 * }} decision
 */
export function formatChoiceNotes(decision) {
  const ranked = Object.entries(decision.probabilities)
    .sort((left, right) => right[1] - left[1])
    .map(([direction, probability]) => `${direction} ${(probability * 100).toFixed(0)}%`);
  return `Jev chose ${decision.choice} (confidence ${(decision.confidence * 100).toFixed(0)}%). Distribution: ${ranked.join(", ")}.`;
}
