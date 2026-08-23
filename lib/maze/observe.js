/**
 * Corridor line-of-sight observation. Walls block vision: nothing beyond a
 * wall is exposed. The produced DTO is the ONLY maze-derived structure that
 * may enter a Walker prompt.
 */

import { DIRECTIONS } from "./types.js";
import { canMove, directionStatus, getNeighbor, samePoint } from "./transition.js";

/** @typedef {import("./types.js").Point} Point */
/** @typedef {import("./types.js").Cell} Cell */
/** @typedef {import("./types.js").DirectionKey} DirectionKey */
/** @typedef {import("./types.js").MoveResult} MoveResult */
/** @typedef {import("./types.js").WalkerObservation} WalkerObservation */

/**
 * Straight sightlines from an origin along each direction. Each visible cell
 * reports its distance and the open directions observable from it. Absolute
 * coordinates are intentionally NOT included in the DTO cells.
 *
 * @param {Cell[][]} cells
 * @param {Point} exit
 * @param {Point} origin
 */
export function walkerSightlines(cells, exit, origin) {
  return DIRECTIONS.map((direction) => {
    /** @type {Array<{ distance: number, openDirections: DirectionKey[], isExit: boolean }>} */
    const seen = [];
    let cursor = origin;
    while (canMove(cells, cursor, direction.key)) {
      cursor = getNeighbor(cursor, direction.key);
      seen.push({
        distance: seen.length + 1,
        openDirections: directionStatus(cells, cursor).openDirections,
        isExit: samePoint(cursor, exit),
      });
    }
    return { direction: direction.key, distanceToWall: seen.length, cells: seen };
  });
}

/**
 * Absolute points currently visible along open corridors. Spectator/UI-only;
 * never sent to the Walker.
 *
 * @param {Cell[][]} cells
 * @param {Point} origin
 * @returns {Set<string>}
 */
export function visibleWalkerPoints(cells, origin) {
  const size = cells.length;
  /** @type {(point: Point) => string} */
  const key = (point) => `${point.r},${point.c}`;
  const visible = new Set([key(origin)]);
  for (const direction of DIRECTIONS) {
    let cursor = origin;
    while (canMove(cells, cursor, direction.key)) {
      cursor = getNeighbor(cursor, direction.key);
      if (cursor.r < 0 || cursor.r >= size || cursor.c < 0 || cursor.c >= size) break;
      visible.add(key(cursor));
    }
  }
  return visible;
}

/**
 * Build the narrow observation DTO for the current turn. Prompt builders must
 * receive exactly this object — never full game state or the maze snapshot.
 *
 * @param {Cell[][]} cells
 * @param {Point} exit
 * @param {Point} origin
 * @param {DirectionKey | null} lastAction
 * @param {MoveResult | null} lastResult
 * @returns {WalkerObservation}
 */
export function walkerObservation(cells, exit, origin, lastAction = null, lastResult = null) {
  const sightlines = walkerSightlines(cells, exit, origin);
  const { openDirections, blockedDirections } = directionStatus(cells, origin);
  return {
    openDirections,
    blockedDirections,
    sightlines,
    exitVisible: sightlines.some((line) => line.cells.some((cell) => cell.isExit)),
    lastAction,
    lastResult,
  };
}
