/**
 * Deterministic mock adapter for offline pipeline validation (dry-run mode).
 *
 * The mock is an online explorer: it builds a map in Walker-relative
 * coordinates purely from the narrow observation DTO (exactly what a real
 * model receives), integrates sightlines, and BFS-walks toward the nearest
 * known frontier or a visible exit. It is fully deterministic and never uses
 * hidden state.
 *
 * Dry-run results are plumbing validation ONLY and must always be labeled as
 * dry-run; they are not live gpt-5.6-luna results.
 */

/** @typedef {import("../contract.js")} contract */

const DIRECTION_ORDER = ["up", "right", "down", "left"];

/** @type {Record<string, { x: number, y: number }>} */
const DELTA = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
};

/**
 * @param {{ deterministicDelayMs?: number }} [options]
 */
export function createMockAdapter(options = {}) {
  const delayMs = options.deterministicDelayMs ?? 0;

  return function decide(request) {
    const observation = request.observation;
    // State derived only from the observable stream.
    if (!decide.state) {
      decide.state = {
        pos: { x: 0, y: 0 },
        /** @type {Map<string, { open: Set<string>, exit: boolean }>} */
        map: new Map(),
      };
    }
    const state = decide.state;

    // Integrate lastAction/lastResult into the believed relative position,
    // exactly like the real Walker must.
    if (observation.lastAction && observation.lastResult === "moved") {
      const delta = DELTA[observation.lastAction];
      state.pos.x += delta.x;
      state.pos.y += delta.y;
    }

    integrate(state.map, state.pos, observation);

    const direction = chooseDirection(state);
    const summaryText = observation.exitVisible
      ? "The exit is visible along a corridor."
      : `I can see ${observation.openDirections.length} open directions and mapped nearby corridors.`;
    const reasoningText = delayMs >= 0 && direction
      ? `Exploring systematically from my map of known corridors; heading ${direction} to reach the nearest unexplored edge.`
      : "No open direction remains.";
    const parsed = {
      observation_summary: summaryText,
      reasoning_summary: reasoningText,
      believed_position: { x: state.pos.x, y: state.pos.y },
      coordinate_note: `Believed (${state.pos.x},${state.pos.y}); known cells: ${state.map.size}.`,
      direction,
    };
    return Promise.resolve({
      attempts: [{
        attempt: 1,
        latencyMs: delayMs,
        responseId: `mock-${request.turn}`,
        requestId: null,
        modelReturned: "mock-explorer",
        status: "completed",
        usage: {
          input_tokens: estimateTokens(observation),
          output_tokens: 64,
          total_tokens: estimateTokens(observation) + 64,
          output_tokens_details: { reasoning_tokens: 0 },
        },
        errorCategory: null,
        rawOutputPreview: JSON.stringify(parsed).slice(0, 240),
      }],
      parsed,
      error: null,
    });
  };
}

/**
 * Fold a narrow observation into the relative-coordinate known map.
 * Sightline cell openDirections reveal walls at visible cells.
 */
function integrate(map, pos, observation) {
  const key = (p) => `${p.x},${p.y}`;
  const here = map.get(key(pos)) ?? { open: new Set(), exit: false };
  for (const direction of observation.openDirections) here.open.add(direction);
  map.set(key(pos), here);

  for (const line of observation.sightlines) {
    let cursor = { ...pos };
    for (const cell of line.cells) {
      cursor = {
        x: cursor.x + DELTA[line.direction].x,
        y: cursor.y + DELTA[line.direction].y,
      };
      const entry = map.get(key(cursor)) ?? { open: new Set(), exit: false };
      for (const direction of cell.openDirections) entry.open.add(direction);
      entry.exit = entry.exit || cell.isExit;
      map.set(key(cursor), entry);
      // The corridor continues past this cell only via line.direction; other
      // sides of this observed cell are classified by its openDirections.
    }
  }
}

/**
 * BFS over the known graph toward the nearest frontier (open edge into an
 * unknown cell); if the exit is known, go there instead.
 */
function chooseDirection(state) {
  const startKey = `${state.pos.x},${state.pos.y}`;
  const exitKey = [...state.map.entries()].find(([, value]) => value.exit)?.[0] ?? null;

  /** @type {Map<string, string | null>} */
  const previous = new Map([[startKey, null]]);
  const queue = [startKey];
  let goal = null;
  while (queue.length > 0) {
    const currentKey = queue.shift();
    const [cx, cy] = currentKey.split(",").map(Number);
    const entry = state.map.get(currentKey);
    if (!entry) continue;
    if (exitKey ? currentKey === exitKey : hasFrontier(state.map, cx, cy)) {
      goal = currentKey;
      break;
    }
    for (const direction of DIRECTION_ORDER) {
      if (!entry.open.has(direction)) continue;
      const next = { x: cx + DELTA[direction].x, y: cy + DELTA[direction].y };
      const nextKey = `${next.x},${next.y}`;
      if (previous.has(nextKey)) continue;
      previous.set(nextKey, currentKey);
      queue.push(nextKey);
    }
  }
  if (!goal || goal === startKey) {
    // Exit reached, no frontier, or already adjacent: pick any open direction.
    return state.map.get(startKey)?.open.values().next().value ?? null;
  }
  // Walk back one step from the goal to find the first move.
  let cursor = goal;
  while (previous.get(cursor) !== startKey) cursor = previous.get(cursor);
  const [fx, fy] = cursor.split(",").map(Number);
  const dx = fx - state.pos.x;
  const dy = fy - state.pos.y;
  return DIRECTION_ORDER.find((direction) => DELTA[direction].x === dx && DELTA[direction].y === dy) ?? null;
}

function hasFrontier(map, x, y) {
  const entry = map.get(`${x},${y}`);
  if (!entry) return false;
  for (const direction of entry.open) {
    const neighborKey = `${x + DELTA[direction].x},${y + DELTA[direction].y}`;
    if (!map.has(neighborKey)) return true;
  }
  return false;
}

function estimateTokens(observation) {
  return 120 + JSON.stringify(observation.sightlines).length >> 3;
}
