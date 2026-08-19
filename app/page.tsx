"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

const SIZE = 9;

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
  misread: boolean;
  result: MoveResult;
};
type GameState = {
  maze: Maze;
  position: Point;
  navigatorBelief: Point;
  turn: number;
  collisions: number;
  status: GameStatus;
  lastReport: string;
  lastInstruction: string;
  lastInstructionDirection: DirectionKey | null;
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
  const start = { r: 0, c: 0 };
  const visited = new Set([pointKey(start)]);
  const stack = [start];

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

  return { cells, start };
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
    const { cells, start } = carveMaze(random);
    const exit = { r: SIZE - 1, c: SIZE - 1 };
    const route = shortestPath(cells, start, exit);
    if (route.length > 1) {
      return {
        cells,
        start,
        exit,
        routeLength: route.length - 1,
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
    : "我在起點附近";

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

function reconcileBelief(
  maze: Maze,
  belief: Point,
  previousInstruction: DirectionKey | null,
  previousResult: MoveResult | null,
  report: string,
) {
  const predicted =
    previousInstruction && previousResult === "moved" && canMove(maze.cells, belief, previousInstruction)
      ? getNeighbor(belief, previousInstruction)
      : belief;

  if (reportMatchesCell(maze.cells, predicted, report)) return predicted;

  const candidates: Point[] = [];
  for (let r = 0; r < SIZE; r += 1) {
    for (let c = 0; c < SIZE; c += 1) {
      const point = { r, c };
      if (reportMatchesCell(maze.cells, point, report)) candidates.push(point);
    }
  }

  return candidates.sort(
    (a, b) =>
      Math.abs(a.r - predicted.r) + Math.abs(a.c - predicted.c) -
      (Math.abs(b.r - predicted.r) + Math.abs(b.c - predicted.c)),
  )[0] ?? belief;
}

function chooseWalkerAction(
  maze: Maze,
  position: Point,
  requested: DirectionKey | null,
  challengeMode: boolean,
) {
  if (!requested || !challengeMode || Math.random() > 0.18) return requested;
  const alternatives = DIRECTIONS.filter(
    (direction) => direction.key !== requested && canMove(maze.cells, position, direction.key),
  );
  return alternatives.length > 0
    ? alternatives[Math.floor(Math.random() * alternatives.length)].key
    : requested;
}

function chooseInstruction(maze: Maze, belief: Point) {
  const path = shortestPath(maze.cells, belief, maze.exit);
  const next = path[1];
  const direction = next ? directionBetween(belief, next) : null;
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
    navigatorBelief: maze.start,
    turn: 0,
    collisions: 0,
    status: "ready",
    lastReport: "我在起點附近；等待第一個指引。",
    lastInstruction: "先觀察你的局部環境。",
    lastInstructionDirection: null,
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
          const isStart = samePoint(cell, game.maze.start);
          const isExit = samePoint(cell, game.maze.exit);
          const isActual = samePoint(cell, game.position);
          const isBelief = samePoint(cell, game.navigatorBelief);
          return (
            <div
              className={`maze-cell ${isStart ? "cell-start" : ""} ${isExit ? "cell-exit" : ""} ${
                isActual ? "cell-actual" : ""
              } ${isBelief ? "cell-belief" : ""}`}
              key={pointKey(cell)}
              style={wallStyle(cell)}
            >
              {isExit ? <span className="exit-mark">E</span> : null}
              {isStart ? <span className="start-mark">S</span> : null}
              {isActual ? <span className="walker-mark">W</span> : null}
              {isBelief ? <span className="belief-mark" aria-label="Navigator 的位置推測" /> : null}
            </div>
          );
        })}
      </div>
      <div className="map-legend">
        <span><i className="legend-swatch swatch-actual" />Walker 真實位置</span>
        <span><i className="legend-swatch swatch-belief" />Navigator 推測</span>
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
  const [challengeMode, setChallengeMode] = useState(false);

  const step = useCallback(() => {
    setGame((current) => {
      if (current.status === "won") return current;

      const report = describeWalker(
        current.maze,
        current.position,
        current.lastAction,
        current.lastResult,
      );
      const reconciledBelief = reconcileBelief(
        current.maze,
        current.navigatorBelief,
        current.lastInstructionDirection,
        current.lastResult,
        report,
      );
      const instruction = chooseInstruction(current.maze, reconciledBelief);
      const direction = instruction.direction;
      const action = chooseWalkerAction(current.maze, current.position, direction, challengeMode);
      const nextPosition = action && canMove(current.maze.cells, current.position, action)
        ? getNeighbor(current.position, action)
        : current.position;
      const result: MoveResult = samePoint(nextPosition, current.position) ? "blocked" : "moved";
      const nextBelief = direction && canMove(current.maze.cells, reconciledBelief, direction)
        ? getNeighbor(reconciledBelief, direction)
        : reconciledBelief;
      const nextTurn = current.turn + 1;
      const won = samePoint(nextPosition, current.maze.exit);
      const log: LogEntry = {
        turn: nextTurn,
        report,
        instruction: instruction.message,
        action: action ? DIRECTIONS.find((item) => item.key === action)?.label ?? "—" : "—",
        misread: action !== direction,
        result,
      };

      return {
        ...current,
        position: nextPosition,
        navigatorBelief: nextBelief,
        turn: nextTurn,
        collisions: current.collisions + (result === "blocked" ? 1 : 0),
        status: won ? "won" : "running",
        lastReport: report,
        lastInstruction: instruction.message,
        lastInstructionDirection: direction,
        lastAction: action,
        lastResult: result,
        logs: [log, ...current.logs].slice(0, 8),
      };
    });
  }, [challengeMode]);

  useEffect(() => {
    if (!autoRun || game.status === "won") return undefined;
    const timer = window.setInterval(step, 950);
    return () => window.clearInterval(timer);
  }, [autoRun, game.status, step]);

  function newMaze() {
    setAutoRun(false);
    setGame(makeInitialGame());
  }

  function toggleChallengeMode() {
    setAutoRun(false);
    setChallengeMode((value) => !value);
    setGame(makeInitialGame(true));
  }

  const statusLabel = game.status === "won" ? "出口已找到" : game.status === "ready" ? "準備開始" : "模擬進行中";
  const statusTone = game.status === "won" ? "success" : game.status === "ready" ? "idle" : "live";

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
          <div className={`mode-pill ${challengeMode ? "challenge-pill" : ""}`}><span className="pulse-dot" />{challengeMode ? "CHALLENGE · 18% NOISE" : "ORACLE BASELINE"}</div>
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
          <p>Navigator reads the whole maze.<br />Walker only sees what is nearby.</p>
        </div>
      </section>

      <section className="control-bar">
        <div className="run-status"><StatusDot status={statusTone} /><span>{statusLabel}</span><span className="run-separator">/</span><span>maze {game.maze.seed}</span></div>
        <div className="control-actions">
          <span className="turn-counter"><strong>{String(game.turn).padStart(2, "0")}</strong> turns</span>
          <button className={`button button-mode ${challengeMode ? "is-challenge" : ""}`} onClick={toggleChallengeMode}>
            {challengeMode ? "Oracle baseline" : "Challenge mode"}
          </button>
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
          <div className="map-heading"><span>Navigator view</span><span>Position is inferred, not given</span></div>
          <FullMaze game={game} />
          <div className="belief-readout">
            <div><span className="readout-label">NAVIGATOR BELIEF</span><strong>row {game.navigatorBelief.r + 1} · col {game.navigatorBelief.c + 1}</strong></div>
            <div><span className="readout-label">ACTUAL WALKER</span><strong className={samePoint(game.position, game.navigatorBelief) ? "match" : "drift"}>row {game.position.r + 1} · col {game.position.c + 1}</strong></div>
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
                <span className={`event-result ${entry.result === "blocked" ? "is-blocked" : ""} ${entry.misread ? "is-misread" : ""}`}>{entry.misread ? `偏離 → 實際${entry.action}` : entry.result === "blocked" ? "撞牆" : `移動 ${entry.action}`}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <footer className="footer-note">
        <span>prototype 01</span>
        <span>fixed shared start · random connected maze · no hidden position feed</span>
        <span>echo / maze</span>
      </footer>
    </main>
  );
}

export default App;
