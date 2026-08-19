"use client";

import { useCallback, useEffect, useState } from "react";
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
type GameStatus = "ready" | "running" | "won";
type LogEntry = {
  turn: number;
  report: string;
  instruction: string;
  action: string;
  result: MoveResult;
};
type GameState = {
  maze: Maze;
  position: Point;
  navigatorCandidates: Point[];
  turn: number;
  collisions: number;
  status: GameStatus;
  lastReport: string;
  lastInstruction: string;
  lastAction: DirectionKey | null;
  lastResult: MoveResult | null;
  logs: LogEntry[];
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

function directionBetween(from: Point, to: Point): DirectionKey | null {
  const delta = { r: to.r - from.r, c: to.c - from.c };
  return (
    DIRECTIONS.find((direction) => direction.dr === delta.r && direction.dc === delta.c)
      ?.key ?? null
  );
}

function describeWalker(
  maze: Maze,
  position: Point,
  lastAction: DirectionKey | null,
  lastResult: MoveResult | null,
) {
  const open = DIRECTIONS.filter((direction) => canMove(maze.cells, position, direction.key)).map(
    (direction) => direction.label,
  );
  const blocked = DIRECTIONS.filter(
    (direction) => !canMove(maze.cells, position, direction.key),
  ).map((direction) => direction.label);
  const actionText = lastAction
    ? `剛才${DIRECTIONS.find((item) => item.key === lastAction)?.phrase ?? "移動"}${
        lastResult === "moved" ? "成功" : "撞牆"
      }`
    : "我從未知位置開始";

  return `${actionText}；${open.length > 0 ? `${open.join("、")}可走` : "附近沒有開路"}，${
    blocked.length > 0 ? `${blocked.join("、")}是牆` : "四周都可走"
  }。`;
}

function parseWalkerReport(report: string) {
  const openMatch = report.match(/；([^，。]+)可走/);
  const blockedMatch = report.match(/，([^。]+)是牆/);
  const open = report.includes("附近沒有開路")
    ? []
    : report.includes("四周都可走")
      ? DIRECTIONS.map((direction) => direction.key)
      : DIRECTIONS.filter((direction) => openMatch?.[1].includes(direction.label)).map(
          (direction) => direction.key,
        );
  const blocked = report.includes("四周都可走")
    ? []
    : DIRECTIONS.filter((direction) => blockedMatch?.[1].includes(direction.label)).map(
        (direction) => direction.key,
      );

  return { open, blocked };
}

function reportMatchesCell(cells: Cell[][], point: Point, report: string) {
  const parsed = parseWalkerReport(report);
  const signature = {
    open: DIRECTIONS.filter((direction) => canMove(cells, point, direction.key)).map(
      (direction) => direction.key,
    ),
    blocked: DIRECTIONS.filter((direction) => !canMove(cells, point, direction.key)).map(
      (direction) => direction.key,
    ),
  };
  return (
    signature.open.length === parsed.open.length &&
    signature.blocked.length === parsed.blocked.length &&
    parsed.open.every((direction) => signature.open.includes(direction)) &&
    parsed.blocked.every((direction) => signature.blocked.includes(direction))
  );
}

function allMazePoints() {
  const points: Point[] = [];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      points.push({ r, c });
    }
  }
  return points;
}

function locateCandidates(maze: Maze, candidates: Point[], report: string) {
  const pool = candidates.length > 0 ? candidates : allMazePoints();
  const matches = pool.filter((point) => reportMatchesCell(maze.cells, point, report));
  if (matches.length > 0) return matches;
  return allMazePoints().filter((point) => reportMatchesCell(maze.cells, point, report));
}

function cellSignature(cells: Cell[][], point: Point) {
  return DIRECTIONS.map((direction) =>
    canMove(cells, point, direction.key) ? direction.label : "牆",
  ).join("|");
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

function chooseDiagnosticDirection(maze: Maze, candidates: Point[]) {
  let bestDirection = DIRECTIONS[0].key;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const direction of DIRECTIONS) {
    const buckets = new Map<string, number>();
    let movable = 0;
    for (const candidate of candidates) {
      const canAdvance = canMove(maze.cells, candidate, direction.key);
      const next = canAdvance ? getNeighbor(candidate, direction.key) : candidate;
      const key = `${canAdvance ? "moved" : "blocked"}:${cellSignature(maze.cells, next)}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
      if (canAdvance) movable += 1;
    }

    const total = candidates.length || 1;
    const entropy = [...buckets.values()].reduce((score, count) => {
      const probability = count / total;
      return score - probability * Math.log2(probability);
    }, 0);
    const score = entropy + (movable / total) * 0.08;
    if (score > bestScore) {
      bestScore = score;
      bestDirection = direction.key;
    }
  }

  return bestDirection;
}

function chooseInstruction(maze: Maze, candidates: Point[]) {
  if (candidates.length !== 1) {
    const direction = chooseDiagnosticDirection(maze, candidates);
    const phrase = DIRECTIONS.find((item) => item.key === direction)?.phrase ?? "移動一步";
    return {
      direction,
      message: `${phrase}，再回報周圍。`,
    };
  }

  const path = shortestPath(maze.cells, candidates[0], maze.exit);
  const next = path[1];
  const direction = next ? directionBetween(candidates[0], next) : null;
  if (!direction) return { direction: null, message: "你已經在出口附近了。" };
  const phrase = DIRECTIONS.find((item) => item.key === direction)?.phrase ?? "繼續走";
  return { direction, message: `${phrase}。` };
}

function makeInitialGame(stable = false): GameState {
  const maze = stable
    ? generateMaze(seededRandom("ECHO-MAZE-DEMO"), "DEMO01")
    : generateMaze();
  return {
    maze,
    position: maze.start,
    navigatorCandidates: [],
    turn: 0,
    collisions: 0,
    status: "ready",
    lastReport: "我不知道自己在地圖上的位置；正在觀察周圍。",
    lastInstruction: "描述你周圍哪些方向可以走。",
    lastAction: null,
    lastResult: null,
    logs: [],
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

function FullMaze({ game }: { game: GameState }) {
  return (
    <div className="maze-wrap" aria-label="完整迷宮地圖">
      <div className="maze-grid full-maze">
        {game.maze.cells.flat().map((cell) => {
          const isExit = samePoint(cell, game.maze.exit);
          const isActual = samePoint(cell, game.position);
          const isCandidate = game.navigatorCandidates.some((candidate) => samePoint(cell, candidate));
          return (
            <div
              className={`maze-cell ${isExit ? "cell-exit" : ""} ${
                isActual ? "cell-actual" : ""
              } ${isCandidate ? "cell-candidate" : ""}`}
              key={pointKey(cell)}
              style={wallStyle(cell)}
            >
              {isExit ? <span className="exit-mark">E</span> : null}
              {isActual ? <span className="walker-mark">W</span> : null}
              {isCandidate ? <span className="candidate-mark" aria-label="Navigator 的候選位置" /> : null}
            </div>
          );
        })}
      </div>
      <div className="map-legend">
        <span><i className="legend-swatch swatch-actual" />Walker 真實位置（觀察者）</span>
        <span><i className="legend-swatch swatch-belief" />Navigator 候選位置</span>
        <span><i className="legend-swatch swatch-exit" />出口</span>
      </div>
    </div>
  );
}

function WalkerView({ game }: { game: GameState }) {
  const cells: Array<Point | null> = [];
  for (let r = -1; r <= 1; r += 1) {
    for (let c = -1; c <= 1; c += 1) {
      const point = { r: game.position.r + r, c: game.position.c + c };
      cells.push(inBounds(point) ? point : null);
    }
  }

  return (
    <div className="local-wrap">
      <div className="local-grid" aria-label="Walker 的 3×3 局部視野">
        {cells.map((point, index) => {
          if (!point) return <div className="local-cell local-out" key={`out-${index}`} />;
          const cell = game.maze.cells[point.r][point.c];
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
      <p className="view-caption">只顯示 Walker 周圍的 3×3 區域</p>
    </div>
  );
}

function App() {
  const [game, setGame] = useState<GameState>(() => makeInitialGame(true));
  const [autoRun, setAutoRun] = useState(false);

  const step = useCallback(() => {
    setGame((current) => {
      if (current.status === "won") return current;

      const report = describeWalker(
        current.maze,
        current.position,
        current.lastAction,
        current.lastResult,
      );
      const locatedCandidates = locateCandidates(
        current.maze,
        current.navigatorCandidates,
        report,
      );
      const instruction = chooseInstruction(current.maze, locatedCandidates);
      const direction = instruction.direction;
      const nextPosition = direction && canMove(current.maze.cells, current.position, direction)
        ? getNeighbor(current.position, direction)
        : current.position;
      const result: MoveResult = samePoint(nextPosition, current.position) ? "blocked" : "moved";
      const nextCandidates = predictCandidates(current.maze, locatedCandidates, direction);
      const nextTurn = current.turn + 1;
      const won = samePoint(nextPosition, current.maze.exit);
      const log: LogEntry = {
        turn: nextTurn,
        report,
        instruction: instruction.message,
        action: direction ? DIRECTIONS.find((item) => item.key === direction)?.label ?? "—" : "—",
        result,
      };

      return {
        ...current,
        position: nextPosition,
        navigatorCandidates: nextCandidates,
        turn: nextTurn,
        collisions: current.collisions + (result === "blocked" ? 1 : 0),
        status: won ? "won" : "running",
        lastReport: report,
        lastInstruction: instruction.message,
        lastAction: direction,
        lastResult: result,
        logs: [log, ...current.logs].slice(0, 8),
      };
    });
  }, []);

  useEffect(() => {
    if (!autoRun || game.status === "won") return undefined;
    const timer = window.setInterval(step, 950);
    return () => window.clearInterval(timer);
  }, [autoRun, game.status, step]);

  function newMaze() {
    setAutoRun(false);
    setGame(makeInitialGame());
  }

  const statusLabel = game.status === "won" ? "出口已找到" : game.status === "ready" ? "準備開始" : "模擬進行中";
  const statusTone = game.status === "won" ? "success" : game.status === "ready" ? "idle" : "live";
  const locatedPosition = game.navigatorCandidates.length === 1
    ? game.navigatorCandidates[0]
    : null;

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
          <div className="mode-pill"><span className="pulse-dot" />HIDDEN-START LOCALIZATION</div>
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
          <p>Navigator sees the maze, but not the start.<br />Walker must help it locate them first.</p>
        </div>
      </section>

      <section className="control-bar">
        <div className="run-status"><StatusDot status={statusTone} /><span>{statusLabel}</span><span className="run-separator">/</span><span>maze {game.maze.seed}</span><span className="run-separator">/</span><span>optimal {game.maze.routeLength} steps</span></div>
        <div className="control-actions">
          <span className="turn-counter"><strong>{String(game.turn).padStart(2, "0")}</strong> turns</span>
          <button className="button button-step" onClick={step} disabled={game.status === "won"}>Step round <span>→</span></button>
          <button className={`button button-run ${autoRun ? "is-running" : ""}`} onClick={() => setAutoRun((value) => !value)} disabled={game.status === "won"}>
            <span className="play-icon">{autoRun ? "Ⅱ" : "▶"}</span>{autoRun ? "Pause" : "Auto-run"}
          </button>
        </div>
      </section>

      <section className="agent-grid">
        <article className="agent-card navigator-card">
          <div className="card-head">
            <div className="agent-name-wrap">
              <div className="agent-avatar navigator-avatar">N</div>
              <div><PanelLabel>AGENT 01 · NAVIGATOR</PanelLabel><h2>The Cartographer</h2></div>
            </div>
            <span className="visibility-tag">FULL MAP</span>
          </div>
          <div className="map-heading"><span>Navigator view + observer overlay</span><span>Orange Walker is hidden from Navigator</span></div>
          <FullMaze game={game} />
          <div className="belief-readout">
            <div><span className="readout-label">LOCATION HYPOTHESES</span><strong className={locatedPosition ? "match" : "drift"}>{locatedPosition ? `row ${locatedPosition.r + 1} · col ${locatedPosition.c + 1}` : game.navigatorCandidates.length > 0 ? `${game.navigatorCandidates.length} possible cells` : "unknown until first report"}</strong></div>
            <div><span className="readout-label">ACTUAL WALKER · OBSERVER ONLY</span><strong>row {game.position.r + 1} · col {game.position.c + 1}</strong></div>
          </div>
          <div className="message-block">
            <div className="message-meta"><span>Navigator → Walker</span><span>one sentence</span></div>
            <p className="message-bubble navigator-message">{game.lastInstruction}</p>
          </div>
        </article>

        <article className="agent-card walker-card">
          <div className="card-head">
            <div className="agent-name-wrap">
              <div className="agent-avatar walker-avatar">W</div>
              <div><PanelLabel>AGENT 02 · WALKER</PanelLabel><h2>The Local Witness</h2></div>
            </div>
            <span className="visibility-tag local-tag">LOCAL 3×3</span>
          </div>
          <div className="map-heading"><span>Walker view</span><span>Only nearby cells are visible</span></div>
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
          <div><PanelLabel>SHARED MEMORY</PanelLabel><h2>Event stream</h2></div>
          <span className="event-caption">The only thing both agents can build together</span>
        </div>
        {game.logs.length === 0 ? (
          <div className="empty-log"><span className="empty-log-mark">◎</span><span>Step the simulation to watch their shared memory take shape.</span></div>
        ) : (
          <div className="event-list">
            {game.logs.map((entry) => (
              <div className="event-row" key={`${entry.turn}-${entry.action}`}>
                <span className="event-turn">T{String(entry.turn).padStart(2, "0")}</span>
                <span className="event-report">{entry.report}</span>
                <span className="event-arrow">→</span>
                <span className="event-instruction">{entry.instruction}</span>
                <span className={`event-result ${entry.result === "blocked" ? "is-blocked" : ""}`}>{entry.result === "blocked" ? "撞牆" : `移動 ${entry.action}`}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="footer-note">
        <span>prototype 01</span>
        <span>random hidden start · random exit · minimum optimal route {MIN_ROUTE_LENGTH}</span>
        <span>echo / maze</span>
      </footer>
    </main>
  );
}

export default App;
