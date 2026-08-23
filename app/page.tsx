"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

const SIZE = 9;
const MIN_ROUTE_LENGTH = 24;

type DirectionKey = "up" | "right" | "down" | "left";
type Point = { r: number; c: number };
type RelativePoint = { x: number; y: number };
type Walls = Record<DirectionKey, boolean>;
type Cell = Point & { walls: Walls };
type Maze = { cells: Cell[][]; start: Point; exit: Point; routeLength: number; seed: string };
type MoveResult = "moved" | "blocked";
type GameStatus = "ready" | "running" | "won";
type GamePhase = "walker_think" | "walker_move";
type RandomSource = () => number;
type ObservableCell = {
  distance: number;
  openDirections: DirectionKey[];
  isExit: boolean;
};
type Sightline = {
  direction: DirectionKey;
  distanceToWall: number;
  cells: Array<Point & ObservableCell>;
};
type WalkerObservation = {
  openDirections: DirectionKey[];
  blockedDirections: DirectionKey[];
  sightlines: Array<{ direction: DirectionKey; distanceToWall: number; cells: ObservableCell[] }>;
  exitVisible: boolean;
  lastAction: DirectionKey | null;
  lastResult: MoveResult | null;
};
type WalkerTurn = {
  turn: number;
  observation: WalkerObservation;
  observationSummary: string;
  reasoning: string;
  believedPosition: RelativePoint;
  coordinateNote: string;
  direction: DirectionKey;
  result: MoveResult | null;
};
type GameState = {
  maze: Maze;
  position: Point;
  relativePosition: RelativePoint;
  phase: GamePhase;
  pendingDirection: DirectionKey | null;
  turn: number;
  collisions: number;
  status: GameStatus;
  lastAction: DirectionKey | null;
  lastResult: MoveResult | null;
  history: WalkerTurn[];
};
type AgentCallMeta = {
  model: string;
  requestId: string | null;
  responseId: string | null;
  status: string;
  attempts: number;
  latencyMs: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    totalTokens: number | null;
  };
};
type SoloWalkerResponse = {
  role: "solo_walker";
  model: "gpt-5.6-luna";
  observationSummary: string;
  reasoning: string;
  believedPosition: RelativePoint;
  coordinateNote: string;
  direction: DirectionKey;
  meta: AgentCallMeta;
};
type ReplayStatus = "starting" | "recording" | "error";
type AgentFailure = { error?: string; code?: string; retryable?: boolean; diagnostic?: unknown };
type ReplayRunSummary = {
  id: string;
  created_at: number;
  updated_at: number;
  status: string;
  model: string;
  maze_seed: string;
  event_count: number;
  max_turn: number | null;
  had_error: number;
};
type ReplayEvent = {
  sequence: number;
  createdAt: number;
  turn: number;
  phase: string;
  type: string;
  payload: unknown;
};
type ReplayDetail = {
  run: {
    id: string;
    status: string;
    mazeSeed: string;
    maze: Maze;
    initialPosition: Point;
  };
  events: ReplayEvent[];
};
type ReplayFrame = {
  game: GameState;
  sequence: number;
  note: string;
  error: string | null;
};
type PlaybackSpeed = 0.5 | 1 | 2 | 4 | 8;

const DIRECTIONS: Array<{ key: DirectionKey; dr: number; dc: number; label: string }> = [
  { key: "up", dr: -1, dc: 0, label: "Up" },
  { key: "right", dr: 0, dc: 1, label: "Right" },
  { key: "down", dr: 1, dc: 0, label: "Down" },
  { key: "left", dr: 0, dc: -1, label: "Left" },
];

const OPPOSITE: Record<DirectionKey, DirectionKey> = {
  up: "down", right: "left", down: "up", left: "right",
};

function samePoint(a: Point, b: Point) { return a.r === b.r && a.c === b.c; }
function pointKey(point: Point) { return `${point.r},${point.c}`; }

function seededRandom(seedText: string): RandomSource {
  let state = 2166136261;
  for (let index = 0; index < seedText.length; index += 1) {
    state ^= seedText.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: RandomSource = Math.random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function makeCells() {
  return Array.from({ length: SIZE }, (_, r) =>
    Array.from({ length: SIZE }, (_, c) => ({
      r, c, walls: { up: true, right: true, down: true, left: true },
    })),
  );
}

function inBounds(point: Point) {
  return point.r >= 0 && point.r < SIZE && point.c >= 0 && point.c < SIZE;
}

function getNeighbor(point: Point, direction: DirectionKey): Point {
  const vector = DIRECTIONS.find((item) => item.key === direction);
  return { r: point.r + (vector?.dr ?? 0), c: point.c + (vector?.dc ?? 0) };
}

function carveMaze(random: RandomSource = Math.random) {
  const cells = makeCells();
  const origin = { r: 0, c: 0 };
  const visited = new Set([pointKey(origin)]);
  const stack = [origin];
  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const options = shuffle(DIRECTIONS, random).filter((direction) => {
      const neighbor = getNeighbor(current, direction.key);
      return inBounds(neighbor) && !visited.has(pointKey(neighbor));
    });
    if (options.length === 0) { stack.pop(); continue; }
    const direction = options[0];
    const next = getNeighbor(current, direction.key);
    cells[current.r][current.c].walls[direction.key] = false;
    cells[next.r][next.c].walls[OPPOSITE[direction.key]] = false;
    visited.add(pointKey(next));
    stack.push(next);
  }
  return cells;
}

function canMove(cells: Cell[][], point: Point, direction: DirectionKey) {
  return inBounds(getNeighbor(point, direction)) && !cells[point.r][point.c].walls[direction];
}

function shortestPath(cells: Cell[][], start: Point, goal: Point) {
  const queue = [start];
  const previous = new Map<string, { point: Point; from: Point | null }>();
  previous.set(pointKey(start), { point: start, from: null });
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || samePoint(current, goal)) break;
    for (const direction of DIRECTIONS) {
      if (!canMove(cells, current, direction.key)) continue;
      const next = getNeighbor(current, direction.key);
      if (previous.has(pointKey(next))) continue;
      previous.set(pointKey(next), { point: next, from: current });
      queue.push(next);
    }
  }
  const path: Point[] = [];
  let cursor: Point | null = goal;
  while (cursor && previous.has(pointKey(cursor))) {
    path.unshift(cursor);
    cursor = previous.get(pointKey(cursor))?.from ?? null;
  }
  return path;
}

function generateMaze(random: RandomSource = Math.random, seedLabel?: string): Maze {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const cells = carveMaze(random);
    const start = { r: Math.floor(random() * SIZE), c: Math.floor(random() * SIZE) };
    const exits: Array<{ point: Point; routeLength: number }> = [];
    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        const point = { r, c };
        const routeLength = shortestPath(cells, start, point).length - 1;
        if (routeLength >= MIN_ROUTE_LENGTH) exits.push({ point, routeLength });
      }
    }
    if (exits.length > 0) {
      const selected = exits[Math.floor(random() * exits.length)];
      return {
        cells, start, exit: selected.point, routeLength: selected.routeLength,
        seed: seedLabel ?? Math.floor(random() * 0xffffffff).toString(36).slice(0, 6).toUpperCase(),
      };
    }
  }
  throw new Error("Could not generate a connected maze.");
}

function walkerSightlines(maze: Maze, origin: Point): Sightline[] {
  return DIRECTIONS.map((direction) => {
    const cells: Sightline["cells"] = [];
    let cursor = origin;
    while (canMove(maze.cells, cursor, direction.key)) {
      cursor = getNeighbor(cursor, direction.key);
      cells.push({
        ...cursor,
        distance: cells.length + 1,
        openDirections: DIRECTIONS.filter((option) => canMove(maze.cells, cursor, option.key)).map((option) => option.key),
        isExit: samePoint(cursor, maze.exit),
      });
    }
    return { direction: direction.key, distanceToWall: cells.length, cells };
  });
}

function visibleWalkerPoints(maze: Maze, origin: Point) {
  const visible = new Set([pointKey(origin)]);
  for (const sightline of walkerSightlines(maze, origin)) {
    for (const cell of sightline.cells) visible.add(pointKey(cell));
  }
  return visible;
}

function walkerObservation(game: GameState): WalkerObservation {
  const sightlines = walkerSightlines(game.maze, game.position);
  return {
    openDirections: DIRECTIONS.filter((direction) => canMove(game.maze.cells, game.position, direction.key)).map((d) => d.key),
    blockedDirections: DIRECTIONS.filter((direction) => !canMove(game.maze.cells, game.position, direction.key)).map((d) => d.key),
    sightlines: sightlines.map((line) => ({
      direction: line.direction,
      distanceToWall: line.distanceToWall,
      cells: line.cells.map(({ distance, openDirections, isExit }) => ({ distance, openDirections, isExit })),
    })),
    exitVisible: sightlines.some((line) => line.cells.some((cell) => cell.isExit)),
    lastAction: game.lastAction,
    lastResult: game.lastResult,
  };
}

function relativePositionAtObservation(history: WalkerTurn[], entryIndex: number): RelativePoint {
  const position = { x: 0, y: 0 };
  for (const entry of history.slice(0, Math.max(0, entryIndex))) {
    if (entry.result !== "moved") continue;
    if (entry.direction === "up") position.y += 1;
    if (entry.direction === "right") position.x += 1;
    if (entry.direction === "down") position.y -= 1;
    if (entry.direction === "left") position.x -= 1;
  }
  return position;
}

function emptyObservation(): WalkerObservation {
  return {
    openDirections: [],
    blockedDirections: [],
    sightlines: [],
    exitVisible: false,
    lastAction: null,
    lastResult: null,
  };
}

function replayPayload(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function replayPoint(value: unknown, fallback: Point): Point {
  if (!value || typeof value !== "object") return fallback;
  const point = value as Partial<Point>;
  return Number.isInteger(point.r) && Number.isInteger(point.c)
    ? { r: point.r as number, c: point.c as number }
    : fallback;
}

function buildReplayFrames(detail: ReplayDetail): ReplayFrame[] {
  let state: GameState = {
    maze: detail.run.maze,
    position: detail.run.initialPosition,
    relativePosition: { x: 0, y: 0 },
    phase: "walker_think",
    pendingDirection: null,
    turn: 0,
    collisions: 0,
    status: "ready",
    lastAction: null,
    lastResult: null,
    history: [],
  };
  const frames: ReplayFrame[] = [{ game: state, sequence: 0, note: "Run loaded", error: null }];
  let pendingObservation = emptyObservation();

  for (const event of detail.events) {
    const payload = replayPayload(event.payload);

    if (event.type === "agent_request" && payload.role === "solo_walker") {
      if (payload.observation && typeof payload.observation === "object") {
        pendingObservation = payload.observation as WalkerObservation;
      }
      continue;
    }

    if (event.type === "solo_walker_response") {
      if (typeof payload.direction !== "string" || !DIRECTIONS.some((item) => item.key === payload.direction)) continue;
      const believed = replayPayload(payload.believedPosition);
      const entry: WalkerTurn = {
        turn: typeof payload.turn === "number" ? payload.turn : state.turn + 1,
        observation: pendingObservation,
        observationSummary: typeof payload.observationSummary === "string" ? payload.observationSummary : "Observation unavailable.",
        reasoning: typeof payload.reasoning === "string" ? payload.reasoning : "Reasoning unavailable.",
        believedPosition: {
          x: typeof believed.x === "number" ? believed.x : 0,
          y: typeof believed.y === "number" ? believed.y : 0,
        },
        coordinateNote: typeof payload.coordinateNote === "string" ? payload.coordinateNote : "Coordinate note unavailable.",
        direction: payload.direction as DirectionKey,
        result: null,
      };
      state = {
        ...state,
        phase: "walker_move",
        pendingDirection: entry.direction,
        status: "running",
        history: [...state.history, entry],
      };
      frames.push({ game: state, sequence: event.sequence, note: `Turn ${entry.turn}: decision`, error: null });
      continue;
    }

    if (event.type === "solo_walker_move" || event.type === "environment_move") {
      const direction = typeof payload.direction === "string" && DIRECTIONS.some((item) => item.key === payload.direction)
        ? payload.direction as DirectionKey
        : null;
      const result: MoveResult = payload.result === "blocked" ? "blocked" : "moved";
      const nextPosition = replayPoint(payload.to, state.position);
      const relative = replayPayload(payload.relativePosition);
      const nextRelativePosition = typeof relative.x === "number" && typeof relative.y === "number"
        ? { x: relative.x, y: relative.y }
        : {
            x: state.relativePosition.x + (result === "moved" && direction === "right" ? 1 : result === "moved" && direction === "left" ? -1 : 0),
            y: state.relativePosition.y + (result === "moved" && direction === "up" ? 1 : result === "moved" && direction === "down" ? -1 : 0),
          };
      const won = payload.won === true;
      state = {
        ...state,
        position: nextPosition,
        relativePosition: nextRelativePosition,
        phase: "walker_think",
        pendingDirection: null,
        turn: state.turn + 1,
        collisions: state.collisions + (result === "blocked" ? 1 : 0),
        status: won ? "won" : "running",
        lastAction: direction,
        lastResult: result,
        history: state.history.map((entry, index) => index === state.history.length - 1 ? { ...entry, result } : entry),
      };
      frames.push({ game: state, sequence: event.sequence, note: won ? "Exit reached" : `Turn ${state.turn}: ${result}`, error: null });
      continue;
    }

    if (event.type === "agent_error") {
      const message = typeof payload.error === "string" ? payload.error : "Agent call failed";
      frames.push({ game: state, sequence: event.sequence, note: "Agent error", error: message });
    }
  }

  return frames;
}

class AgentRequestError extends Error {
  details: AgentFailure;
  constructor(details: AgentFailure) {
    super(details.error ?? "The agent request failed.");
    this.name = "AgentRequestError";
    this.details = details;
  }
}

async function requestAgent<T>(payload: unknown): Promise<T> {
  const response = await fetch("/api/agent", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const data = (await response.json()) as T & AgentFailure;
  if (!response.ok) throw new AgentRequestError(data);
  return data;
}

async function postReplay(payload: unknown) {
  const response = await fetch("/api/replays", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Could not save replay data.");
}

function makeInitialGame(stable = false): GameState {
  const maze = stable ? generateMaze(seededRandom("ECHO-MAZE-DEMO"), "DEMO01") : generateMaze();
  return {
    maze, position: maze.start, relativePosition: { x: 0, y: 0 }, phase: "walker_think", pendingDirection: null,
    turn: 0, collisions: 0, status: "ready", lastAction: null, lastResult: null, history: [],
  };
}

function wallStyle(cell: Cell): CSSProperties {
  const wallColor = "rgba(147, 179, 190, 0.72)";
  return {
    borderTopColor: cell.walls.up ? wallColor : "transparent",
    borderRightColor: cell.walls.right ? wallColor : "transparent",
    borderBottomColor: cell.walls.down ? wallColor : "transparent",
    borderLeftColor: cell.walls.left ? wallColor : "transparent",
  };
}

function StatusDot({ status }: { status: "live" | "idle" | "success" }) {
  return <span className={`status-dot status-${status}`} aria-hidden="true" />;
}
function PanelLabel({ children }: { children: ReactNode }) { return <span className="panel-label">{children}</span>; }

function WalkerView({ game, hidden }: { game: GameState; hidden: boolean }) {
  const visible = visibleWalkerPoints(game.maze, game.position);
  return (
    <div className={`map-layer walker-map-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
      <div className="local-grid" aria-label="Walker line-of-sight view along open corridors">
        {game.maze.cells.flat().map((cell) => {
          const point = { r: cell.r, c: cell.c };
          if (!visible.has(pointKey(point))) return <div className="local-cell local-hidden" key={pointKey(point)} aria-label="Area hidden by walls" />;
          const isCenter = samePoint(point, game.position);
          const isExit = samePoint(point, game.maze.exit);
          return (
            <div className={`local-cell ${isCenter ? "local-center" : ""} ${isExit ? "local-exit" : ""}`} key={pointKey(point)} style={wallStyle(cell)}>
              {isCenter ? <span className="local-walker">W</span> : null}
              {isExit ? <span className="local-exit-mark">EXIT</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SpectatorMap({ game, hidden }: { game: GameState; hidden: boolean }) {
  return (
    <div className={`map-layer spectator-map-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
      <div className="maze-grid full-maze" aria-label="Complete maze spectator view">
        {game.maze.cells.flat().map((cell) => {
          const point = { r: cell.r, c: cell.c };
          const isWalker = samePoint(point, game.position);
          const isExit = samePoint(point, game.maze.exit);
          return (
            <div className={`maze-cell ${isExit ? "cell-exit" : ""}`} key={pointKey(point)} style={wallStyle(cell)}>
              {isExit ? <span className="exit-mark">EXIT</span> : null}
              {isWalker ? <span className="spectator-walker">W</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MazeViewport({ game, showFullMap }: { game: GameState; showFullMap: boolean }) {
  return (
    <div className="map-viewport">
      <div className="map-stage">
        <WalkerView game={game} hidden={showFullMap} />
        <SpectatorMap game={game} hidden={!showFullMap} />
      </div>
      <div className="map-legend-slot" aria-hidden="true">
        <div className={`map-legend mode-legend ${showFullMap ? "is-hidden" : "is-visible"}`}>
          <span><i className="legend-swatch swatch-visible" />Visible corridor</span>
          <span><i className="legend-swatch swatch-unknown" />Hidden by walls</span>
        </div>
        <div className={`map-legend mode-legend ${showFullMap ? "is-visible" : "is-hidden"}`}>
          <span><i className="legend-swatch swatch-walker" />Walker&apos;s actual position</span>
          <span><i className="legend-swatch swatch-exit" />Exit</span>
        </div>
      </div>
      <p className="map-mode-caption">
        {showFullMap
          ? "Spectator mode: the complete map and actual position are never shown to Walker."
          : "Walls block sight; Walker has no absolute coordinates or complete map."}
      </p>
    </div>
  );
}

function ThoughtStream({ history, isThinking }: { history: WalkerTurn[]; isThinking: boolean }) {
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.scrollTo({ top: stream.scrollHeight, behavior: history.length > 1 ? "smooth" : "auto" });
  }, [history.length, isThinking]);

  return (
    <div className="thought-stream" aria-live="polite" ref={streamRef}>
      {history.length === 0 && !isThinking ? (
        <div className="thought-empty">
          <span>◎</span>
          <p>No memory yet. Once the first turn begins, Walker must navigate using only the conversation accumulated in this run.</p>
        </div>
      ) : null}
      {history.map((entry) => (
        <article className="thought-entry" key={entry.turn}>
          <div className="thought-turn">TURN {String(entry.turn).padStart(2, "0")}</div>
          <div className="thought-section">
            <span>OBSERVATION</span>
            <p>{entry.observationSummary}</p>
          </div>
          <div className="thought-section reasoning-section">
            <span>REASONING SUMMARY</span>
            <p>{entry.reasoning}</p>
          </div>
          <div className="coordinate-note">
            <div><span>SELF-REPORTED POSITION</span><strong>({entry.believedPosition?.x ?? 0}, {entry.believedPosition?.y ?? 0})</strong></div>
            <p>{entry.coordinateNote ?? "This older entry has no coordinate note."}</p>
          </div>
          <div className="thought-decision">
            <span>DECISION</span>
            <strong>Move {DIRECTIONS.find((item) => item.key === entry.direction)?.label}</strong>
            <em className={entry.result === "blocked" ? "is-blocked" : ""}>
              {entry.result === "blocked" ? "Blocked — stayed in place" : entry.result === "moved" ? "Move succeeded" : "Awaiting move"}
            </em>
          </div>
        </article>
      ))}
      {isThinking ? (
        <div className="thinking-row"><span /><span /><span /><p>Walker is reviewing the full conversation…</p></div>
      ) : null}
    </div>
  );
}

function App() {
  const [game, setGame] = useState<GameState>(() => makeInitialGame(true));
  const [autoRun, setAutoRun] = useState(false);
  const [showFullMap, setShowFullMap] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>("starting");
  const [replayRuns, setReplayRuns] = useState<ReplayRunSummary[]>([]);
  const [selectedReplayId, setSelectedReplayId] = useState("");
  const [playbackFrames, setPlaybackFrames] = useState<ReplayFrame[]>([]);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(2);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [isReplayLoading, setIsReplayLoading] = useState(false);
  const [replayLibraryError, setReplayLibraryError] = useState<string | null>(null);
  const replayRunIdRef = useRef<string | null>(null);
  const replaySequencesRef = useRef(new Map<string, number>());
  const replayQueueRef = useRef<Promise<void>>(Promise.resolve());

  const queueReplay = useCallback((payload: unknown) => {
    const pending = replayQueueRef.current.catch(() => undefined).then(() => postReplay(payload))
      .then(() => setReplayStatus("recording"))
      .catch((error) => { console.error("Echo Maze replay recording failed:", error); setReplayStatus("error"); });
    replayQueueRef.current = pending;
  }, []);

  const startReplay = useCallback((initialGame: GameState) => {
    const runId = crypto.randomUUID();
    replayRunIdRef.current = runId;
    replaySequencesRef.current.set(runId, 0);
    setReplayRunId(runId);
    setReplayStatus("starting");
    queueReplay({
      action: "create", runId, createdAt: Date.now(), model: "gpt-5.6-luna",
      mazeSeed: initialGame.maze.seed, maze: initialGame.maze, initialPosition: initialGame.position,
    });
    return runId;
  }, [queueReplay]);

  const recordReplay = useCallback((runId: string | null, snapshot: GameState, type: string, payload: unknown) => {
    if (!runId) return;
    const sequence = (replaySequencesRef.current.get(runId) ?? 0) + 1;
    replaySequencesRef.current.set(runId, sequence);
    queueReplay({ action: "event", runId, sequence, createdAt: Date.now(), turn: snapshot.turn, phase: snapshot.phase, type, payload });
  }, [queueReplay]);

  const finishReplay = useCallback((runId: string | null, status: "won" | "abandoned" | "stopped") => {
    if (runId) queueReplay({ action: "finish", runId, updatedAt: Date.now(), status });
  }, [queueReplay]);

  useEffect(() => { if (!replayRunIdRef.current) startReplay(game); }, [game, startReplay]);

  const refreshReplayRuns = useCallback(async () => {
    try {
      const response = await fetch("/api/replays");
      if (!response.ok) throw new Error("Could not load saved runs.");
      const data = await response.json() as { runs?: ReplayRunSummary[] };
      setReplayRuns(data.runs ?? []);
      setReplayLibraryError(null);
    } catch (error) {
      setReplayLibraryError(error instanceof Error ? error.message : "Could not load saved runs.");
    }
  }, []);

  useEffect(() => { void refreshReplayRuns(); }, [refreshReplayRuns]);

  const loadReplay = useCallback(async (runId: string) => {
    setSelectedReplayId(runId);
    setIsReplayPlaying(false);
    setPlaybackIndex(0);
    if (!runId) {
      setPlaybackFrames([]);
      return;
    }
    setAutoRun(false);
    setIsReplayLoading(true);
    setReplayLibraryError(null);
    try {
      const response = await fetch(`/api/replays?id=${encodeURIComponent(runId)}&compact=1`);
      if (!response.ok) throw new Error("Could not load this replay.");
      const detail = await response.json() as ReplayDetail;
      const frames = buildReplayFrames(detail);
      setPlaybackFrames(frames);
      setPlaybackIndex(0);
    } catch (error) {
      setPlaybackFrames([]);
      setReplayLibraryError(error instanceof Error ? error.message : "Could not load this replay.");
    } finally {
      setIsReplayLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isReplayPlaying || playbackFrames.length < 2) return undefined;
    if (playbackIndex >= playbackFrames.length - 1) {
      setIsReplayPlaying(false);
      return undefined;
    }
    const timer = window.setTimeout(
      () => setPlaybackIndex((index) => Math.min(index + 1, playbackFrames.length - 1)),
      700 / playbackSpeed,
    );
    return () => window.clearTimeout(timer);
  }, [isReplayPlaying, playbackFrames.length, playbackIndex, playbackSpeed]);

  const step = useCallback(async () => {
    if (isThinking || game.status === "won") return;
    const snapshot = game;
    const runId = replayRunIdRef.current;
    const activeTurn = snapshot.turn + 1;

    if (snapshot.phase === "walker_move") {
      const direction = snapshot.pendingDirection;
      const nextPosition = direction && canMove(snapshot.maze.cells, snapshot.position, direction)
        ? getNeighbor(snapshot.position, direction) : snapshot.position;
      const result: MoveResult = samePoint(nextPosition, snapshot.position) ? "blocked" : "moved";
      const won = samePoint(nextPosition, snapshot.maze.exit);
      const vector = direction && result === "moved"
        ? ({ up: { x: 0, y: 1 }, right: { x: 1, y: 0 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 } } as const)[direction]
        : { x: 0, y: 0 };
      const nextRelativePosition = {
        x: (snapshot.relativePosition?.x ?? 0) + vector.x,
        y: (snapshot.relativePosition?.y ?? 0) + vector.y,
      };
      recordReplay(runId, snapshot, "solo_walker_move", { direction, result, from: snapshot.position, to: nextPosition, relativePosition: nextRelativePosition, won });
      if (won) finishReplay(runId, "won");
      setGame((current) => current !== snapshot ? current : ({
        ...current,
        position: nextPosition,
        relativePosition: nextRelativePosition,
        phase: "walker_think",
        pendingDirection: null,
        turn: activeTurn,
        collisions: current.collisions + (result === "blocked" ? 1 : 0),
        status: won ? "won" : "running",
        lastAction: direction,
        lastResult: result,
        history: current.history.map((entry, index) => index === current.history.length - 1 ? { ...entry, result } : entry),
      }));
      return;
    }

    setIsThinking(true);
    setAgentError(null);
    try {
      const requestPayload = {
        role: "solo_walker",
        turn: activeTurn,
        observation: walkerObservation(snapshot),
        conversation: snapshot.history,
      } as const;
      recordReplay(runId, snapshot, "agent_request", requestPayload);
      const response = await requestAgent<SoloWalkerResponse>(requestPayload);
      recordReplay(runId, snapshot, "solo_walker_response", response);
      const entry: WalkerTurn = {
        turn: activeTurn,
        observation: requestPayload.observation,
        observationSummary: response.observationSummary,
        reasoning: response.reasoning,
        believedPosition: response.believedPosition,
        coordinateNote: response.coordinateNote,
        direction: response.direction,
        result: null,
      };
      setGame((current) => current !== snapshot ? current : ({
        ...current, phase: "walker_move", pendingDirection: response.direction,
        status: "running", history: [...current.history, entry],
      }));
    } catch (error) {
      setAutoRun(false);
      recordReplay(runId, snapshot, "agent_error", error instanceof AgentRequestError ? error.details : { error: error instanceof Error ? error.message : "The agent request failed." });
      setAgentError(error instanceof Error ? error.message : "The agent request failed.");
    } finally { setIsThinking(false); }
  }, [finishReplay, game, isThinking, recordReplay]);

  useEffect(() => {
    if (!autoRun || isThinking || game.status === "won") return undefined;
    const timer = window.setTimeout(() => void step(), 900);
    return () => window.clearTimeout(timer);
  }, [autoRun, game.status, isThinking, step]);

  function newMaze() {
    finishReplay(replayRunIdRef.current, "abandoned");
    setAutoRun(false);
    setSelectedReplayId("");
    setPlaybackFrames([]);
    setIsReplayPlaying(false);
    setAgentError(null);
    const next = makeInitialGame();
    setGame(next);
    startReplay(next);
  }

  async function exportReplay() {
    const runId = replayRunIdRef.current;
    if (!runId) return;
    try {
      await replayQueueRef.current;
      const response = await fetch(`/api/replays?id=${encodeURIComponent(runId)}`);
      if (!response.ok) throw new Error("Could not export this replay.");
      const replay = await response.json();
      const url = URL.createObjectURL(new Blob([JSON.stringify(replay, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `echo-maze-solo-${game.maze.seed}-${runId.slice(0, 8)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) { setAgentError(error instanceof Error ? error.message : "Could not export this replay."); }
  }

  const playbackFrame = playbackFrames[playbackIndex] ?? null;
  const isReplayMode = Boolean(selectedReplayId && playbackFrame);
  const displayGame = playbackFrame?.game ?? game;
  const selectedReplay = replayRuns.find((run) => run.id === selectedReplayId) ?? null;
  const statusLabel = isReplayMode
    ? `Replay · ${selectedReplay?.status ?? "recorded"}`
    : displayGame.status === "won" ? "Exit found" : displayGame.status === "ready" ? "Ready" : "Exploring";
  const statusTone = displayGame.status === "won" ? "success" : displayGame.status === "ready" ? "idle" : "live";
  const lastThought = displayGame.history.at(-1);
  const reportedPosition = lastThought?.believedPosition ?? { x: 0, y: 0 };
  const expectedReportedPosition = relativePositionAtObservation(displayGame.history, displayGame.history.length - 1);
  const coordinateIsConsistent = reportedPosition.x === expectedReportedPosition.x && reportedPosition.y === expectedReportedPosition.y;

  return (
    <main className="echo-app">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><div className="brand-name">ECHO MAZE</div><div className="brand-subtitle">one agent · only its own memory</div></div>
        </div>
        <div className="top-actions">
          <div className="mode-pill"><span className="pulse-dot" />SOLO WALKER · GPT-5.6 LUNA</div>
          <button className="button button-quiet" onClick={newMaze}>New maze <span>↗</span></button>
        </div>
      </header>

      <section className="intro-row solo-intro">
        <div><p className="eyebrow">CONVERSATION-ONLY MEMORY</p><h1>Can one agent remember<br /><em>the maze it cannot see?</em></h1></div>
        <div className="intro-note"><span className="note-line" /><p>No map. No route tool. No notebook.<br />Only observations, decisions, and outcomes from this run.</p></div>
      </section>

      <section className="control-bar">
        <div className="control-info">
          <div className="run-status"><StatusDot status={statusTone} /><span>{statusLabel}</span><span className="run-separator">/</span><span>maze {displayGame.maze.seed}</span><span className="run-separator">/</span><span>optimal {displayGame.maze.routeLength} steps</span><span className="run-separator">/</span><span className={`replay-state replay-${replayStatus}`}>{isReplayMode ? `frame ${playbackIndex + 1}/${playbackFrames.length}` : `replay ${replayStatus}`}</span></div>
          <div className="phase-track" aria-label="Turn phases"><span className={displayGame.phase === "walker_think" ? "is-active" : ""}>1 · Observe & reason</span><i>→</i><span className={displayGame.phase === "walker_move" ? "is-active" : ""}>2 · Move & remember outcome</span></div>
        </div>
        <div className="control-actions">
          <span className="turn-counter"><strong>{String(displayGame.turn).padStart(2, "0")}</strong> turns</span>
          <button className="button button-export" onClick={() => void exportReplay()} disabled={!replayRunId || replayStatus === "starting"}>Export replay</button>
          <button className="button button-step" onClick={() => void step()} disabled={isReplayMode || game.status === "won" || isThinking}>{isThinking ? "Walker thinking…" : game.phase === "walker_think" ? "Ask Walker" : "Move Walker"} <span>→</span></button>
          <button className={`button button-run ${autoRun ? "is-running" : ""}`} onClick={() => setAutoRun((value) => !value)} disabled={isReplayMode || game.status === "won"}><span className="play-icon">{autoRun ? "Ⅱ" : "▶"}</span>{autoRun ? "Pause" : "Auto-run"}</button>
        </div>
      </section>

      {agentError ? <div className="agent-error" role="alert"><strong>Agent call failed</strong><span>{agentError}</span><button type="button" onClick={() => setAgentError(null)}>Dismiss</button></div> : null}

      <section className="agent-grid solo-grid">
        <article className="agent-card thought-card">
          <div className="card-head">
            <div className="agent-name-wrap"><div className="agent-avatar walker-avatar">W</div><div><PanelLabel>AGENT OUTPUT</PanelLabel><h2>Walker&apos;s reasoning log</h2></div></div>
            <span className="visibility-tag">FULL RUN HISTORY</span>
          </div>
          <div className="thought-disclaimer">A concise explanation Walker provides each turn—not the model&apos;s hidden chain of thought.</div>
          <ThoughtStream history={displayGame.history} isThinking={!isReplayMode && isThinking} />
        </article>

        <article className="agent-card walker-card">
          <div className="card-head">
            <div className="agent-name-wrap"><div className="agent-avatar walker-avatar">W</div><div><PanelLabel>WALKER VIEW</PanelLabel><h2>The Local Explorer</h2></div></div>
            <div className="card-head-actions">
              <button className="button view-toggle" type="button" aria-pressed={showFullMap} onClick={() => setShowFullMap((value) => !value)}>
                {showFullMap ? "Show Walker view" : "Show full map"}
              </button>
              <span className={`visibility-tag ${showFullMap ? "spectator-tag" : "local-tag"}`}>{showFullMap ? "SPECTATOR" : "LINE OF SIGHT"}</span>
            </div>
          </div>
          <div className="map-heading">
            <span>{showFullMap ? "Full maze for the observer" : "What the agent can see now"}</span>
            <span>{showFullMap ? "Hidden from Walker" : "Walls hide everything beyond them"}</span>
          </div>
          <MazeViewport game={displayGame} showFullMap={showFullMap} />
          <div className="action-readout">
            <div><span className="readout-label">LAST ACTION</span><strong>{displayGame.lastAction ? `Move ${DIRECTIONS.find((item) => item.key === displayGame.lastAction)?.label}` : "—"}</strong></div>
            <div><span className="readout-label">OUTCOME</span><strong className={displayGame.lastResult === "blocked" ? "blocked-text" : "match"}>{displayGame.lastResult === "blocked" ? "Blocked" : displayGame.lastResult === "moved" ? "Move succeeded" : "Not started"}</strong></div>
            <div><span className="readout-label">COLLISIONS</span><strong>{String(displayGame.collisions).padStart(2, "0")}</strong></div>
          </div>
          <div className="coordinate-readout">
            <span className="readout-label">WALKER&apos;S BELIEVED COORDINATE</span>
            <strong className={!lastThought || coordinateIsConsistent ? "match" : "drift"}>
              {lastThought ? `(${reportedPosition.x}, ${reportedPosition.y})` : "(0, 0)"}
            </strong>
            <em>{lastThought ? (coordinateIsConsistent ? "coordinate consistent" : "coordinate drift detected") : "origin"}</em>
          </div>
        </article>
      </section>

      <section className="replay-console" aria-label="Saved replay controls">
        <div className="replay-console-head">
          <div><PanelLabel>REPLAY LIBRARY</PanelLabel><h2>Review any recorded run</h2></div>
          <div className="replay-head-actions">
            <span>{replayRuns.length} saved runs</span>
            <button className="button replay-refresh" type="button" onClick={() => void refreshReplayRuns()}>Refresh</button>
          </div>
        </div>
        <div className="replay-controls">
          <label className="replay-field replay-run-field">
            <span>RUN</span>
            <select value={selectedReplayId} onChange={(event) => void loadReplay(event.target.value)} disabled={isReplayLoading}>
              <option value="">Live game</option>
              {replayRuns.map((run) => (
                <option value={run.id} key={run.id}>
                  {run.maze_seed} · {run.status.toUpperCase()} · {run.max_turn ?? 0} turns{run.had_error ? " · error logged" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="replay-field replay-speed-field">
            <span>SPEED</span>
            <select value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value) as PlaybackSpeed)}>
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={4}>4×</option>
              <option value={8}>8×</option>
            </select>
          </label>
          <div className="replay-buttons">
            <button className="button replay-restart" type="button" disabled={!isReplayMode || isReplayLoading} onClick={() => { setPlaybackIndex(0); setIsReplayPlaying(false); }}>↺ Restart</button>
            <button
              className={`button replay-play ${isReplayPlaying ? "is-playing" : ""}`}
              type="button"
              disabled={!isReplayMode || isReplayLoading || playbackFrames.length < 2}
              onClick={() => {
                if (!isReplayPlaying && playbackIndex >= playbackFrames.length - 1) setPlaybackIndex(0);
                setIsReplayPlaying((value) => !value);
              }}
            >
              {isReplayLoading ? "Loading…" : isReplayPlaying ? "Ⅱ Pause" : "▶ Play"}
            </button>
          </div>
        </div>
        <div className="replay-timeline">
          <input
            type="range"
            min={0}
            max={Math.max(0, playbackFrames.length - 1)}
            value={Math.min(playbackIndex, Math.max(0, playbackFrames.length - 1))}
            onChange={(event) => { setPlaybackIndex(Number(event.target.value)); setIsReplayPlaying(false); }}
            disabled={!isReplayMode || playbackFrames.length < 2}
            aria-label="Replay position"
          />
          <div className="replay-timeline-meta">
            <span>{isReplayMode ? `${playbackIndex + 1} / ${playbackFrames.length}` : "Select a run to begin"}</span>
            <strong className={playbackFrame?.error ? "has-error" : selectedReplay?.status === "won" ? "is-won" : ""}>
              {playbackFrame?.error ?? playbackFrame?.note ?? "All outcomes are available for replay"}
            </strong>
            {isReplayMode ? <button type="button" onClick={() => void loadReplay("")}>Return to live game</button> : <span />}
          </div>
        </div>
        {replayLibraryError ? <p className="replay-library-error">{replayLibraryError}</p> : null}
      </section>

      <footer className="footer-note"><span>solo walker experiment</span><span>conversation-only memory · no map · no route tool · minimum optimal route {MIN_ROUTE_LENGTH}</span><span>echo / maze</span></footer>
    </main>
  );
}

export default App;
