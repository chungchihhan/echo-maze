"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

const SIZE = 9;
const MIN_ROUTE_LENGTH = 24;

type DirectionKey = "up" | "right" | "down" | "left";
type Point = { r: number; c: number };
type Walls = Record<DirectionKey, boolean>;
type Cell = Point & { walls: Walls };
type Maze = {
  cells: Cell[][];
  start: Point;
  exit: Point;
  routeLength: number;
  seed: string;
};
type MoveResult = "moved" | "blocked";
type Sightline = {
  direction: DirectionKey;
  distanceToWall: number;
  cells: Array<Point & { distance: number; openDirections: DirectionKey[]; isExit: boolean }>;
};
type GameStatus = "ready" | "running" | "won";
type GamePhase = "walker_report" | "navigator_reply" | "walker_check" | "walker_move";
type NavigatorMode = "localizing" | "routing";
type TimelineActor = "walker" | "navigator" | "environment";
type ConversationEntry = {
  actor: "walker" | "navigator";
  turn: number;
  kind: "report" | "instruction" | "verification" | "challenge";
  text: string;
};
type LogEntry = {
  id: string;
  turn: number;
  actor: TimelineActor;
  label: string;
  text: string;
  result?: MoveResult;
};
type GameState = {
  maze: Maze;
  position: Point;
  navigatorCandidates: Point[];
  navigatorMode: NavigatorMode;
  navigatorRoute: Point[];
  phase: GamePhase;
  pendingDirection: DirectionKey | null;
  turn: number;
  collisions: number;
  status: GameStatus;
  lastReport: string;
  lastInstruction: string;
  lastAction: DirectionKey | null;
  lastResult: MoveResult | null;
  logs: LogEntry[];
  conversation: ConversationEntry[];
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
type WalkerAgentResponse = {
  role: "walker";
  model: "gpt-5.6-luna";
  report: string;
  meta: AgentCallMeta;
};
type WalkerCheckResponse = {
  role: "walker_check";
  model: "gpt-5.6-luna";
  decision: "move" | "challenge";
  message: string;
  meta: AgentCallMeta;
};
type NavigatorAgentResponse = {
  role: "navigator";
  model: "gpt-5.6-luna";
  message: string;
  direction: DirectionKey;
  candidates: Point[];
  navigationMode: NavigatorMode;
  route: Point[];
  meta: AgentCallMeta;
};
type ReplayStatus = "starting" | "recording" | "error";
type AgentFailure = {
  error?: string;
  code?: string;
  retryable?: boolean;
  diagnostic?: unknown;
};
type RandomSource = () => number;

const DIRECTIONS: Array<{
  key: DirectionKey;
  dr: number;
  dc: number;
  label: string;
  phrase: string;
}> = [
  { key: "up", dr: -1, dc: 0, label: "上", phrase: "往上走" },
  { key: "right", dr: 0, dc: 1, label: "右", phrase: "往右走" },
  { key: "down", dr: 1, dc: 0, label: "下", phrase: "往下走" },
  { key: "left", dr: 0, dc: -1, label: "左", phrase: "往左走" },
];

const OPPOSITE: Record<DirectionKey, DirectionKey> = {
  up: "down",
  right: "left",
  down: "up",
  left: "right",
};

function samePoint(a: Point, b: Point) {
  return a.r === b.r && a.c === b.c;
}

function pointKey(point: Point) {
  return `${point.r},${point.c}`;
}

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
      r,
      c,
      walls: { up: true, right: true, down: true, left: true },
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

function directionBetweenPoints(from: Point, to: Point): DirectionKey | null {
  return DIRECTIONS.find((direction) =>
    from.r + direction.dr === to.r && from.c + direction.dc === to.c,
  )?.key ?? null;
}

function carveMaze(random: RandomSource = Math.random) {
  const cells = makeCells();
  const carveOrigin = { r: 0, c: 0 };
  const visited = new Set([pointKey(carveOrigin)]);
  const stack = [carveOrigin];

  while (stack.length > 0) {
    const current = stack[stack.length - 1];
    const options = shuffle(DIRECTIONS, random).filter((direction) => {
      const neighbor = getNeighbor(current, direction.key);
      return inBounds(neighbor) && !visited.has(pointKey(neighbor));
    });

    if (options.length === 0) {
      stack.pop();
      continue;
    }

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
  const next = getNeighbor(point, direction);
  return inBounds(next) && !cells[point.r][point.c].walls[direction];
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
        openDirections: DIRECTIONS.filter((option) =>
          canMove(maze.cells, cursor, option.key),
        ).map((option) => option.key),
        isExit: samePoint(cursor, maze.exit),
      });
    }

    return {
      direction: direction.key,
      distanceToWall: cells.length,
      cells,
    };
  });
}

function visibleWalkerPoints(maze: Maze, origin: Point) {
  const visible = new Set([pointKey(origin)]);
  for (const sightline of walkerSightlines(maze, origin)) {
    for (const cell of sightline.cells) visible.add(pointKey(cell));
  }
  return visible;
}

function shortestPath(cells: Cell[][], start: Point, goal: Point) {
  const queue = [start];
  const previous = new Map<string, { point: Point; from: Point | null }>();
  previous.set(pointKey(start), { point: start, from: null });

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    if (samePoint(current, goal)) break;

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
    const start = {
      r: Math.floor(random() * SIZE),
      c: Math.floor(random() * SIZE),
    };
    const exits: Array<{ point: Point; routeLength: number }> = [];

    for (let r = 0; r < SIZE; r += 1) {
      for (let c = 0; c < SIZE; c += 1) {
        const point = { r, c };
        const routeLength = shortestPath(cells, start, point).length - 1;
        if (routeLength >= MIN_ROUTE_LENGTH) exits.push({ point, routeLength });
      }
    }

    if (exits.length > 0) {
      const selectedExit = exits[Math.floor(random() * exits.length)];
      return {
        cells,
        start,
        exit: selectedExit.point,
        routeLength: selectedExit.routeLength,
        seed: seedLabel ?? Math.floor(random() * 0xffffffff).toString(36).slice(0, 6).toUpperCase(),
      };
    }
  }

  throw new Error("Could not generate a connected maze.");
}

function predictCandidates(maze: Maze, candidates: Point[], direction: DirectionKey | null) {
  if (!direction) return candidates;
  const unique = new Map<string, Point>();
  for (const candidate of candidates) {
    const next = canMove(maze.cells, candidate, direction)
      ? getNeighbor(candidate, direction)
      : candidate;
    unique.set(pointKey(next), next);
  }
  return [...unique.values()];
}

function walkerObservation(game: GameState) {
  const openDirections = DIRECTIONS.filter((direction) =>
    canMove(game.maze.cells, game.position, direction.key),
  ).map((direction) => direction.key);
  const blockedDirections = DIRECTIONS.filter(
    (direction) => !canMove(game.maze.cells, game.position, direction.key),
  ).map((direction) => direction.key);
  const sightlines = walkerSightlines(game.maze, game.position);
  const exitVisible = sightlines.some((sightline) =>
    sightline.cells.some((cell) => cell.isExit),
  );

  return {
    openDirections,
    blockedDirections,
    sightlines,
    exitVisible,
    lastAction: game.lastAction,
    lastResult: game.lastResult,
    navigatorInstruction: game.lastInstruction,
  };
}

function navigatorMaze(maze: Maze) {
  return {
    size: SIZE,
    exit: maze.exit,
    cells: maze.cells.flat().map((cell) => ({
      r: cell.r,
      c: cell.c,
      open: DIRECTIONS.filter((direction) => !cell.walls[direction.key]).map(
        (direction) => direction.key,
      ),
    })),
  };
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as T & AgentFailure;
  if (!response.ok) throw new AgentRequestError(data);
  return data;
}

async function postReplay(payload: unknown) {
  const response = await fetch("/api/replays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? "Could not save replay data.");
  }
}

function makeInitialGame(stable = false): GameState {
  const maze = stable
    ? generateMaze(seededRandom("ECHO-MAZE-DEMO"), "DEMO01")
    : generateMaze();
  return {
    maze,
    position: maze.start,
    navigatorCandidates: [],
    navigatorMode: "localizing",
    navigatorRoute: [],
    phase: "walker_report",
    pendingDirection: null,
    turn: 0,
    collisions: 0,
    status: "ready",
    lastReport: "我不知道自己在地圖上的位置；正在觀察周圍。",
    lastInstruction: "描述你周圍哪些方向可以走。",
    lastAction: null,
    lastResult: null,
    logs: [],
    conversation: [],
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

function PanelLabel({ children }: { children: ReactNode }) {
  return <span className="panel-label">{children}</span>;
}

function FullMaze({ maze, candidates, route }: { maze: Maze; candidates: Point[]; route: Point[] }) {
  return (
    <div className="maze-wrap" aria-label="完整迷宮地圖">
      <div className="maze-grid full-maze">
        {maze.cells.flat().map((cell) => {
          const isExit = samePoint(cell, maze.exit);
          const isCandidate = candidates.some((candidate) => samePoint(cell, candidate));
          const routeIndex = route.findIndex((routePoint) => samePoint(cell, routePoint));
          const isRoute = routeIndex >= 0;
          const routeConnections = isRoute
            ? [route[routeIndex - 1], route[routeIndex + 1]]
              .filter((point): point is Point => Boolean(point))
              .map((point) => directionBetweenPoints(cell, point))
              .filter((direction): direction is DirectionKey => Boolean(direction))
            : [];
          return (
            <div
              className={`maze-cell ${isExit ? "cell-exit" : ""} ${isCandidate ? "cell-candidate" : ""} ${isRoute ? "cell-route" : ""}`}
              key={pointKey(cell)}
              style={wallStyle(cell)}
            >
              {isExit ? <span className="exit-mark">E</span> : null}
              {isRoute ? (
                <span className="route-path" aria-label="Navigator 取得的路線">
                  {routeConnections.map((direction) => (
                    <i className={`route-line route-${direction}`} key={direction} />
                  ))}
                </span>
              ) : null}
              {isCandidate ? <span className="candidate-mark" aria-label="Navigator 的候選位置" /> : null}
            </div>
          );
        })}
      </div>
      <div className="map-legend">
        <span><i className="legend-swatch swatch-belief" />Navigator 候選位置</span>
        <span><i className="legend-swatch swatch-route" />Route tool 路線</span>
        <span><i className="legend-swatch swatch-exit" />出口</span>
      </div>
    </div>
  );
}

function WalkerView({ game }: { game: GameState }) {
  const visible = visibleWalkerPoints(game.maze, game.position);

  return (
    <div className="local-wrap">
      <div className="local-grid" aria-label="Walker 沿通道延伸的直線視野">
        {game.maze.cells.flat().map((cell) => {
          const point = { r: cell.r, c: cell.c };
          if (!visible.has(pointKey(point))) {
            return <div className="local-cell local-hidden" key={pointKey(point)} aria-label="被牆遮蔽的區域" />;
          }
          const isCenter = samePoint(point, game.position);
          const isExit = samePoint(point, game.maze.exit);
          return (
            <div
              className={`local-cell ${isCenter ? "local-center" : ""} ${isExit ? "local-exit" : ""}`}
              key={pointKey(point)}
              style={wallStyle(cell)}
            >
              {isCenter ? <span className="local-walker">W</span> : null}
              {isExit ? <span className="local-exit-mark">出口</span> : null}
            </div>
          );
        })}
      </div>
      <p className="view-caption">視線沿直線通道延伸至牆面；轉角後方保持未知</p>
    </div>
  );
}

function App() {
  const [game, setGame] = useState<GameState>(() => makeInitialGame(true));
  const [autoRun, setAutoRun] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>("starting");
  const replayRunIdRef = useRef<string | null>(null);
  const replaySequencesRef = useRef(new Map<string, number>());
  const replayQueueRef = useRef<Promise<void>>(Promise.resolve());

  const queueReplay = useCallback((payload: unknown) => {
    const pending = replayQueueRef.current
      .catch(() => undefined)
      .then(() => postReplay(payload))
      .then(() => setReplayStatus("recording"))
      .catch((error) => {
        console.error("Echo Maze replay recording failed:", error);
        setReplayStatus("error");
      });
    replayQueueRef.current = pending;
  }, []);

  const startReplay = useCallback((initialGame: GameState) => {
    const runId = crypto.randomUUID();
    replayRunIdRef.current = runId;
    replaySequencesRef.current.set(runId, 0);
    setReplayRunId(runId);
    setReplayStatus("starting");
    queueReplay({
      action: "create",
      runId,
      createdAt: Date.now(),
      model: "gpt-5.6-luna",
      mazeSeed: initialGame.maze.seed,
      maze: initialGame.maze,
      initialPosition: initialGame.position,
    });
    return runId;
  }, [queueReplay]);

  const recordReplay = useCallback((
    runId: string | null,
    snapshot: GameState,
    type: string,
    payload: unknown,
  ) => {
    if (!runId) return;
    const sequence = (replaySequencesRef.current.get(runId) ?? 0) + 1;
    replaySequencesRef.current.set(runId, sequence);
    queueReplay({
      action: "event",
      runId,
      sequence,
      createdAt: Date.now(),
      turn: snapshot.turn,
      phase: snapshot.phase,
      type,
      payload,
    });
  }, [queueReplay]);

  const finishReplay = useCallback((runId: string | null, status: "won" | "abandoned" | "stopped") => {
    if (!runId) return;
    queueReplay({ action: "finish", runId, updatedAt: Date.now(), status });
  }, [queueReplay]);

  useEffect(() => {
    if (!replayRunIdRef.current) startReplay(game);
  }, [game, startReplay]);

  const step = useCallback(async () => {
    if (isThinking || game.status === "won") return;
    const snapshot = game;
    const activeReplayRunId = replayRunIdRef.current;
    const activeTurn = snapshot.turn + 1;

    if (snapshot.phase === "walker_move") {
      const direction = snapshot.pendingDirection;
      const nextPosition = direction && canMove(snapshot.maze.cells, snapshot.position, direction)
        ? getNeighbor(snapshot.position, direction)
        : snapshot.position;
      const result: MoveResult = samePoint(nextPosition, snapshot.position) ? "blocked" : "moved";
      const nextCandidates = predictCandidates(snapshot.maze, snapshot.navigatorCandidates, direction);
      const won = samePoint(nextPosition, snapshot.maze.exit);
      const action = direction
        ? DIRECTIONS.find((item) => item.key === direction)?.label ?? "—"
        : "—";
      const log: LogEntry = {
        id: `${activeTurn}-environment`,
        turn: activeTurn,
        actor: "environment",
        label: "Walker acts",
        text: result === "blocked" ? `${action}方是牆，Walker 留在原地。` : `Walker 向${action}移動一格。`,
        result,
      };

      recordReplay(activeReplayRunId, snapshot, "environment_move", {
        direction,
        result,
        from: snapshot.position,
        to: nextPosition,
        candidatesBefore: snapshot.navigatorCandidates,
        candidatesAfter: nextCandidates,
        won,
      });
      if (result === "blocked") {
        recordReplay(activeReplayRunId, snapshot, "relocalization", {
          reason: "movement contradicted the active route",
          claimedCandidates: snapshot.navigatorCandidates,
          claimedRoute: snapshot.navigatorRoute,
          actualPosition: snapshot.position,
        });
      }
      if (won) finishReplay(activeReplayRunId, "won");

      setGame((current) => current !== snapshot ? current : ({
        ...current,
        position: nextPosition,
        navigatorCandidates: nextCandidates,
        navigatorMode: result === "blocked" ? "localizing" : current.navigatorMode,
        navigatorRoute: result === "blocked" ? [] : current.navigatorRoute.slice(1),
        phase: "walker_report",
        pendingDirection: null,
        turn: activeTurn,
        collisions: current.collisions + (result === "blocked" ? 1 : 0),
        status: won ? "won" : "running",
        lastAction: direction,
        lastResult: result,
        logs: [log, ...current.logs].slice(0, 18),
      }));
      return;
    }

    setIsThinking(true);
    setAgentError(null);
    try {
      if (snapshot.phase === "walker_report") {
        const requestPayload = {
          role: "walker",
          turn: activeTurn,
          observation: walkerObservation(snapshot),
        } as const;
        recordReplay(activeReplayRunId, snapshot, "agent_request", requestPayload);
        const response = await requestAgent<WalkerAgentResponse>(requestPayload);
        recordReplay(activeReplayRunId, snapshot, "walker_response", response);
        const log: LogEntry = {
          id: `${activeTurn}-walker`,
          turn: activeTurn,
          actor: "walker",
          label: "Walker reports",
          text: response.report,
        };
        const conversationEntry: ConversationEntry = {
          actor: "walker",
          turn: activeTurn,
          kind: "report",
          text: response.report,
        };
        setGame((current) => current !== snapshot ? current : ({
          ...current,
          phase: "navigator_reply",
          status: "running",
          lastReport: response.report,
          logs: [log, ...current.logs].slice(0, 18),
          conversation: [...current.conversation, conversationEntry],
        }));
        return;
      }

      if (snapshot.phase === "walker_check") {
        const requestPayload = {
          role: "walker_check",
          turn: activeTurn,
          instruction: snapshot.lastInstruction,
          direction: snapshot.pendingDirection,
          observation: walkerObservation(snapshot),
        } as const;
        recordReplay(activeReplayRunId, snapshot, "agent_request", requestPayload);
        const response = await requestAgent<WalkerCheckResponse>(requestPayload);
        recordReplay(activeReplayRunId, snapshot, "walker_check_response", response);
        const challenged = response.decision === "challenge";
        const log: LogEntry = {
          id: `${activeTurn}-walker-check`,
          turn: activeTurn,
          actor: "walker",
          label: challenged ? "challenges instruction" : "verifies instruction",
          text: response.message,
        };
        const conversationEntry: ConversationEntry = {
          actor: "walker",
          turn: activeTurn,
          kind: challenged ? "challenge" : "verification",
          text: response.message,
        };
        if (challenged) {
          recordReplay(activeReplayRunId, snapshot, "relocalization", {
            reason: response.message,
            claimedCandidates: snapshot.navigatorCandidates,
            claimedRoute: snapshot.navigatorRoute,
            actualPosition: snapshot.position,
          });
        }
        setGame((current) => current !== snapshot ? current : ({
          ...current,
          phase: challenged ? "navigator_reply" : "walker_move",
          navigatorMode: challenged ? "localizing" : current.navigatorMode,
          navigatorRoute: challenged ? [] : current.navigatorRoute,
          pendingDirection: challenged ? null : current.pendingDirection,
          turn: challenged ? activeTurn : current.turn,
          lastReport: response.message,
          logs: [log, ...current.logs].slice(0, 18),
          conversation: [...current.conversation, conversationEntry],
        }));
        return;
      }

      const requestPayload = {
        role: "navigator",
        turn: activeTurn,
        maze: navigatorMaze(snapshot.maze),
        previousCandidates: snapshot.navigatorCandidates,
        conversation: snapshot.conversation,
      } as const;
      recordReplay(activeReplayRunId, snapshot, "agent_request", requestPayload);
      const response = await requestAgent<NavigatorAgentResponse>(requestPayload);
      recordReplay(activeReplayRunId, snapshot, "navigator_response", response);
      const claimedPosition = response.navigationMode === "routing" && response.candidates.length === 1
        ? response.candidates[0]
        : null;
      if (claimedPosition) {
        recordReplay(activeReplayRunId, snapshot, "localization_evaluation", {
          claimedPosition,
          actualPosition: snapshot.position,
          correct: samePoint(claimedPosition, snapshot.position),
          route: response.route,
        });
        recordReplay(activeReplayRunId, snapshot, "route_acquired", {
          claimedPosition,
          route: response.route,
          nextDirection: response.direction,
        });
      } else if (snapshot.navigatorMode === "routing" && response.navigationMode === "localizing") {
        recordReplay(activeReplayRunId, snapshot, "relocalization", {
          reason: "Navigator revised its locked position after new evidence",
          claimedCandidates: snapshot.navigatorCandidates,
          claimedRoute: snapshot.navigatorRoute,
          actualPosition: snapshot.position,
        });
      }
      const log: LogEntry = {
        id: `${activeTurn}-navigator`,
        turn: activeTurn,
        actor: "navigator",
        label: "Navigator replies",
        text: response.message,
      };
      const conversationEntry: ConversationEntry = {
        actor: "navigator",
        turn: activeTurn,
        kind: "instruction",
        text: response.message,
      };
      setGame((current) => current !== snapshot ? current : ({
        ...current,
        phase: "walker_check",
        navigatorCandidates: response.candidates,
        navigatorMode: response.navigationMode,
        navigatorRoute: response.route,
        pendingDirection: response.direction,
        lastInstruction: response.message,
        logs: [log, ...current.logs].slice(0, 18),
        conversation: [...current.conversation, conversationEntry],
      }));
    } catch (error) {
      setAutoRun(false);
      recordReplay(activeReplayRunId, snapshot, "agent_error", error instanceof AgentRequestError
        ? error.details
        : { error: error instanceof Error ? error.message : "The agent request failed." });
      setAgentError(error instanceof Error ? error.message : "The agent request failed.");
    } finally {
      setIsThinking(false);
    }
  }, [finishReplay, game, isThinking, recordReplay]);

  useEffect(() => {
    if (!autoRun || isThinking || game.status === "won") return undefined;
    const timer = window.setTimeout(() => void step(), 900);
    return () => window.clearTimeout(timer);
  }, [autoRun, game.status, isThinking, step]);

  function newMaze() {
    finishReplay(replayRunIdRef.current, "abandoned");
    setAutoRun(false);
    setAgentError(null);
    const nextGame = makeInitialGame();
    setGame(nextGame);
    startReplay(nextGame);
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
      anchor.download = `echo-maze-${game.maze.seed}-${runId.slice(0, 8)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Could not export this replay.");
    }
  }

  const statusLabel = game.status === "won" ? "出口已找到" : game.status === "ready" ? "準備開始" : "模擬進行中";
  const statusTone = game.status === "won" ? "success" : game.status === "ready" ? "idle" : "live";
  const locatedPosition = game.navigatorCandidates.length === 1
    ? game.navigatorCandidates[0]
    : null;
  const stepLabel = game.phase === "walker_report"
    ? "Walker report"
    : game.phase === "navigator_reply"
      ? "Navigator respond"
      : game.phase === "walker_check"
        ? "Walker verify"
        : "Walker move";
  const navigationState = game.navigatorCandidates.length === 0
    ? "waiting for first report"
    : game.navigatorMode === "routing" && locatedPosition
      ? `location locked · ${Math.max(0, game.navigatorRoute.length - 1)} route steps`
      : "narrowing location";

  return (
    <main className="echo-app">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div>
            <div className="brand-name">ECHO MAZE</div>
            <div className="brand-subtitle">two agents · one shared way out</div>
          </div>
        </div>
        <div className="top-actions">
          <div className="mode-pill"><span className="pulse-dot" />LIVE · GPT-5.6 LUNA</div>
          <button className="button button-quiet" onClick={newMaze}>New maze <span>↗</span></button>
        </div>
      </header>

      <section className="intro-row">
        <div>
          <p className="eyebrow">OBSERVABLE CO-OPERATION</p>
          <h1>Can they find the way<br /><em>without seeing the same world?</em></h1>
        </div>
        <div className="intro-note">
          <span className="note-line" />
          <p>Navigator sees the maze, but not the start.<br />Walker sees down corridors until a wall blocks the view.</p>
        </div>
      </section>

      <section className="control-bar">
        <div className="control-info">
          <div className="run-status"><StatusDot status={statusTone} /><span>{statusLabel}</span><span className="run-separator">/</span><span>maze {game.maze.seed}</span><span className="run-separator">/</span><span>optimal {game.maze.routeLength} steps</span><span className="run-separator">/</span><span className={`replay-state replay-${replayStatus}`}>replay {replayStatus}</span></div>
          <div className="phase-track" aria-label="回合的四個階段">
            <span className={game.phase === "walker_report" ? "is-active" : ""}>1 · Walker reports</span>
            <i>→</i>
            <span className={game.phase === "navigator_reply" ? "is-active" : ""}>2 · Navigator locates</span>
            <i>→</i>
            <span className={game.phase === "walker_check" ? "is-active" : ""}>3 · Walker verifies</span>
            <i>→</i>
            <span className={game.phase === "walker_move" ? "is-active" : ""}>4 · Walker moves</span>
          </div>
        </div>
        <div className="control-actions">
          <span className="turn-counter"><strong>{String(game.turn).padStart(2, "0")}</strong> turns</span>
          <button className="button button-export" onClick={() => void exportReplay()} disabled={!replayRunId || replayStatus === "starting"}>Export replay</button>
          <button className="button button-step" onClick={() => void step()} disabled={game.status === "won" || isThinking}>{isThinking ? "Agent thinking…" : stepLabel} <span>→</span></button>
          <button className={`button button-run ${autoRun ? "is-running" : ""}`} onClick={() => setAutoRun((value) => !value)} disabled={game.status === "won"}>
            <span className="play-icon">{autoRun ? "Ⅱ" : "▶"}</span>{autoRun ? "Pause" : "Auto-run"}
          </button>
        </div>
      </section>

      {agentError ? (
        <div className="agent-error" role="alert">
          <strong>Agent call failed</strong>
          <span>{agentError}</span>
          <button type="button" onClick={() => setAgentError(null)}>Dismiss</button>
        </div>
      ) : null}

      <section className="agent-grid">
        <article className="agent-card navigator-card">
          <div className="card-head">
            <div className="agent-name-wrap">
              <div className="agent-avatar navigator-avatar">N</div>
              <div><PanelLabel>AGENT 01 · NAVIGATOR</PanelLabel><h2>The Cartographer</h2></div>
            </div>
            <span className="visibility-tag">FULL MAP</span>
          </div>
          <div className="map-heading"><span>Navigator view</span><span>Start and live position are hidden</span></div>
          <FullMaze maze={game.maze} candidates={game.navigatorCandidates} route={game.navigatorRoute} />
          <div className="belief-readout">
            <div><span className="readout-label">LOCATION HYPOTHESES</span><strong className={locatedPosition ? "match" : "drift"}>{locatedPosition ? `row ${locatedPosition.r + 1} · col ${locatedPosition.c + 1}` : game.navigatorCandidates.length > 0 ? `${game.navigatorCandidates.length} possible cells` : "unknown until first report"}</strong></div>
            <div><span className="readout-label">NAVIGATION STATE</span><strong>{navigationState}</strong></div>
          </div>
          <div className="message-block">
            <div className="message-meta"><span>Navigator → Walker</span><span>{game.navigatorMode}</span></div>
            <p className="message-bubble navigator-message">{game.lastInstruction}</p>
          </div>
        </article>

        <article className="agent-card walker-card">
          <div className="card-head">
            <div className="agent-name-wrap">
              <div className="agent-avatar walker-avatar">W</div>
              <div><PanelLabel>AGENT 02 · WALKER</PanelLabel><h2>The Local Witness</h2></div>
            </div>
            <span className="visibility-tag local-tag">LINE OF SIGHT</span>
          </div>
          <div className="map-heading"><span>Walker view</span><span>Walls block line of sight</span></div>
          <WalkerView game={game} />
          <div className="action-readout">
            <div><span className="readout-label">LAST ACTION</span><strong>{game.lastAction ? DIRECTIONS.find((item) => item.key === game.lastAction)?.label : "—"}</strong></div>
            <div><span className="readout-label">OUTCOME</span><strong className={game.lastResult === "blocked" ? "blocked-text" : "match"}>{game.lastResult === "blocked" ? "撞牆" : game.lastResult === "moved" ? "成功移動" : "等待開始"}</strong></div>
            <div><span className="readout-label">COLLISIONS</span><strong>{String(game.collisions).padStart(2, "0")}</strong></div>
          </div>
          <div className="message-block">
            <div className="message-meta"><span>Walker → Navigator</span><span>local report</span></div>
            <p className="message-bubble walker-message">{game.lastReport}</p>
          </div>
        </article>
      </section>

      <section className="event-card">
        <div className="event-head">
          <div><PanelLabel>EVENT STREAM</PanelLabel><h2>Shared conversation</h2></div>
          <span className="event-caption">Their only shared context</span>
        </div>
        {game.logs.length === 0 ? (
          <div className="empty-log"><span className="empty-log-mark">◎</span><span>Start the simulation to open the conversation.</span></div>
        ) : (
          <div className="chat-stream" aria-live="polite">
            {[...game.logs].reverse().map((entry) => (
              entry.actor === "environment" ? (
                <div className={`chat-system ${entry.result === "blocked" ? "is-blocked" : ""}`} key={entry.id}>
                  <span className="chat-system-turn">T{String(entry.turn).padStart(2, "0")}</span>
                  <span className="chat-system-icon" aria-hidden="true">↳</span>
                  <span>{entry.text}</span>
                </div>
              ) : (
                <article className={`chat-message chat-${entry.actor}`} key={entry.id}>
                  <div className="chat-avatar" aria-hidden="true">{entry.actor === "navigator" ? "N" : "W"}</div>
                  <div className="chat-content">
                    <div className="chat-meta">
                      <strong>{entry.actor === "navigator" ? "Navigator" : "Walker"}</strong>
                      <span>T{String(entry.turn).padStart(2, "0")} · {entry.label}</span>
                    </div>
                    <p>{entry.text}</p>
                  </div>
                </article>
              )
            ))}
          </div>
        )}
      </section>

      <footer className="footer-note">
        <span>prototype 01</span>
        <span>hidden state · report → infer → verify → move · minimum optimal route {MIN_ROUTE_LENGTH}</span>
        <span>echo / maze</span>
      </footer>
    </main>
  );
}

export default App;
