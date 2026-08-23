/**
 * Pure maze core types and constants for Echo Maze.
 *
 * This module must stay free of React, DOM, Cloudflare bindings, D1, and
 * OpenAI dependencies. It is shared verbatim by the browser UI and the
 * headless benchmark runner so both use identical environment semantics.
 */

/**
 * Ordered direction table. `dr`/`dc` are absolute grid deltas:
 * rows increase downward, columns increase rightward.
 */
export const DIRECTIONS = [
  { key: "up", dr: -1, dc: 0, label: "Up" },
  { key: "right", dr: 0, dc: 1, label: "Right" },
  { key: "down", dr: 1, dc: 0, label: "Down" },
  { key: "left", dr: 0, dc: -1, label: "Left" },
];

/** @typedef {"up"|"right"|"down"|"left"} DirectionKey */

/** @type {Record<DirectionKey, DirectionKey>} */
export const OPPOSITE = {
  up: "down",
  right: "left",
  down: "up",
  left: "right",
};

/** Fixed square maze edge length for Echo Maze v0. */
export const MAZE_SIZE = 9;

/** Minimum optimal route length (in moves) for generated mazes. */
export const MIN_ROUTE_LENGTH = 24;

/**
 * @typedef {{ r: number, c: number }} Point
 * @typedef {{ x: number, y: number }} RelativePoint
 * @typedef {{ up: boolean, right: boolean, down: boolean, left: boolean }} Walls
 * @typedef {Point & { walls: Walls }} Cell
 * @typedef {{
 *   cells: Cell[][],
 *   start: Point,
 *   exit: Point,
 *   routeLength: number,
 *   seed: string,
 * }} Maze
 * @typedef {"moved"|"blocked"} MoveResult
 * @typedef {{ distance: number, openDirections: DirectionKey[], isExit: boolean }} ObservableCell
 * @typedef {{ direction: DirectionKey, distanceToWall: number, cells: ObservableCell[] }} SightlineDTO
 */

/**
 * Narrow, visibility-safe observation handed to the Walker (and to any prompt
 * builder). Contains no absolute coordinates, no seed, no exit coordinates,
 * and no unseen cells. Exit presence is only signaled per visible cell via
 * `isExit`.
 *
 * @typedef {{
 *   openDirections: DirectionKey[],
 *   blockedDirections: DirectionKey[],
 *   sightlines: SightlineDTO[],
 *   exitVisible: boolean,
 *   lastAction: DirectionKey | null,
 *   lastResult: MoveResult | null,
 * }} WalkerObservation
 */

/**
 * @param {DirectionKey} key
 * @returns {{ dr: number, dc: number } | undefined}
 */
export function directionVector(key) {
  return DIRECTIONS.find((direction) => direction.key === key);
}

/** @returns {boolean} */
export function isDirectionKey(value) {
  return typeof value === "string" && DIRECTION_KEYS.includes(value);
}

const DIRECTION_KEYS = DIRECTIONS.map((direction) => direction.key);
