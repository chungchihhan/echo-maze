"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  DIRECTIONS,
  MIN_ROUTE_LENGTH,
  canMove,
  generateMaze,
  getNeighbor,
  pointKey,
  samePoint,
  seededRandom,
  visibleWalkerPoints,
  walkerObservation as observeWalkerCell,
} from "../lib/maze/index.js";
import type { Cell, DirectionKey, Maze, MoveResult, Point } from "../lib/maze/types.js";
import { DEMO_REPLAY_DETAIL, DEMO_REPLAY_PROVENANCE, type DemoReplayDetail } from "./demo-replay";
import { HeroMaze } from "./hero-maze";

// Environment semantics (maze generation, movement, corridor line-of-sight)
// live in ../lib/maze and are shared verbatim with the headless benchmark
// runner. This component owns only presentation state.
type RelativePoint = { x: number; y: number };
type GameStatus = "ready" | "running" | "won";
type GamePhase = "walker_think" | "walker_move";
type ObservationDTO = {
  openDirections: DirectionKey[];
  blockedDirections: DirectionKey[];
  sightlines: Array<{ direction: DirectionKey; distanceToWall: number; cells: Array<{ distance: number; openDirections: DirectionKey[]; isExit: boolean }> }>;
  exitVisible: boolean;
  lastAction: DirectionKey | null;
  lastResult: MoveResult | null;
};
type WalkerTurn = {
  turn: number;
  observation: ObservationDTO;
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
  is_demo?: boolean;
};
type ReplayDetail = DemoReplayDetail;
type ReplayFrame = {
  game: GameState;
  sequence: number;
  note: string;
  error: string | null;
};
type PlaybackSpeed = 0.5 | 1 | 2 | 4 | 8;

const HERO_MAZE = generateMaze(seededRandom("ECHO-MAZE-HERO"), "HERO01");

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

function emptyObservation(): ObservationDTO {
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
        pendingObservation = payload.observation as ObservationDTO;
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

const DEMO_REPLAY_FRAMES = buildReplayFrames(DEMO_REPLAY_DETAIL);
const DEMO_REPLAY_TURNS = DEMO_REPLAY_FRAMES
  .map((frame) => frame.game.history.at(-1))
  .filter((thought): thought is WalkerTurn => Boolean(thought))
  .filter((thought, index, thoughts) => index === 0 || thought.turn !== thoughts[index - 1].turn);

const DEMO_REPLAY_SUMMARY: ReplayRunSummary = {
  id: DEMO_REPLAY_DETAIL.run.id,
  created_at: DEMO_REPLAY_DETAIL.run.createdAt,
  updated_at: DEMO_REPLAY_DETAIL.run.updatedAt,
  status: "won",
  model: DEMO_REPLAY_DETAIL.run.model,
  maze_seed: DEMO_REPLAY_DETAIL.run.mazeSeed,
  event_count: DEMO_REPLAY_DETAIL.events.length,
  max_turn: DEMO_REPLAY_PROVENANCE.turns,
  had_error: 0,
  is_demo: true,
};

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
  // Wall stroke derives from the Factory pale-stone token (--wall-stroke in globals.css).
  const wallColor = "var(--wall-stroke)";
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

function BrandMark({ inverse = false }: { inverse?: boolean }) {
  return <span className={`brand-mark${inverse ? " brand-mark-inverse" : ""}`} aria-hidden="true" />;
}

const GITHUB_REPOSITORY_URL = "https://github.com/chungchihhan/echo-maze";
const LANDING_PATH = "/";

function AppNavigation({ currentPath }: { currentPath: "/" | "/replay" }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBrandVisible, setIsBrandVisible] = useState(currentPath === "/");
  const navigationRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (currentPath !== "/") return undefined;

    const brand = document.querySelector(".hero-brand-lockup");
    if (!brand || typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver(([entry]) => setIsBrandVisible(Boolean(entry?.isIntersecting)), { threshold: 0.01 });
    observer.observe(brand);
    return () => observer.disconnect();
  }, [currentPath]);

  const closeNavigation = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => toggleRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeNavigation(true);
    };
    const handleOutsidePointer = (event: PointerEvent) => {
      if (!navigationRef.current?.contains(event.target as Node)) closeNavigation();
    };

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("pointerdown", handleOutsidePointer);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("pointerdown", handleOutsidePointer);
    };
  }, [closeNavigation, isOpen]);

  const linkTabIndex = isOpen ? 0 : -1;

  return (
    <div className={`app-navigation ${isOpen ? "is-open" : ""} ${isBrandVisible ? "" : "is-brand-offscreen"}`} ref={navigationRef}>
      <button
        ref={toggleRef}
        className="nav-menu-toggle"
        type="button"
        aria-expanded={isOpen}
        aria-controls="echo-navigation"
        aria-label={isOpen ? "Close navigation" : "Open navigation"}
        onClick={() => setIsOpen((value) => !value)}
      >
        <BrandMark inverse />
      </button>
      <div className="app-nav-popover" id="echo-navigation" aria-hidden={!isOpen}>
        <div className="app-nav-heading">
          <div>
            <PanelLabel>MENU</PanelLabel>
            <strong>Move through Echo Maze</strong>
          </div>
          <button className="nav-close" type="button" tabIndex={linkTabIndex} aria-label="Close navigation" onClick={() => closeNavigation(true)}>×</button>
        </div>
        <nav className="app-nav-links" aria-label="Primary navigation">
          <a className={`app-nav-link ${currentPath === LANDING_PATH ? "is-current" : ""}`} href={LANDING_PATH} aria-current={currentPath === LANDING_PATH ? "page" : undefined} tabIndex={linkTabIndex} onClick={() => closeNavigation()}>
            <span>Landing</span><span aria-hidden="true">↗</span>
          </a>
          <a className={`app-nav-link ${currentPath === "/replay" ? "is-current" : ""}`} href="/replay" aria-current={currentPath === "/replay" ? "page" : undefined} tabIndex={linkTabIndex} onClick={() => closeNavigation()}>
            <span>Replay workspace</span><span aria-hidden="true">↗</span>
          </a>
          <a className="app-nav-link" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer" tabIndex={linkTabIndex} onClick={() => closeNavigation()}>
            <span>GitHub repository</span><span aria-hidden="true">↗</span>
          </a>
        </nav>
      </div>
    </div>
  );
}

type PageMode = "replay" | "lab";

function Masthead({ mode, onNewMaze }: { mode: PageMode; onNewMaze?: () => void }) {
  const isLab = mode === "lab";
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <BrandMark inverse />
        <div><div className="brand-name">ECHO MAZE</div><div className="brand-subtitle">one agent · only its own memory</div></div>
      </div>
      {isLab ? (
        <div className="top-actions">
          <div className="mode-pill is-live"><span className="pulse-dot" />LIVE LAB · SOLO WALKER</div>
          {onNewMaze ? <button className="button button-quiet" onClick={onNewMaze}>New maze <span>↗</span></button> : null}
        </div>
      ) : null}
    </header>
  );
}

function IntroSection({ mode, showReplayLink = false }: { mode: PageMode; showReplayLink?: boolean }) {
  const isLab = mode === "lab";
  return (
    <section className="intro-row solo-intro">
      <div className="intro-panel intro-panel-light">
        {!isLab ? (
          <div className="brand-lockup hero-brand-lockup">
            <BrandMark />
            <div><div className="brand-name">ECHO MAZE</div></div>
          </div>
        ) : null}
        {isLab ? <p className="eyebrow">CONVERSATION-ONLY MEMORY</p> : null}
        <h1>{isLab ? <>Can one agent remember <em>the maze it cannot see?</em></> : <>Watch one agent <em>remember what it saw.</em></>}</h1>
        {showReplayLink ? <a className="hero-replay-link" href="/replay">Open replay workspace <span aria-hidden="true">↗</span></a> : null}
      </div>
      <div className="intro-panel intro-panel-blue">
        <HeroMaze maze={HERO_MAZE} />
        <div className="intro-note">
          <p>{isLab ? <>No map. No route tool. No notebook.<br />Only observations, decisions, and outcomes from this run.</> : <>Replay the decisions, outcomes, and memory<br />from a completed Walker run.</>}</p>
        </div>
      </div>
    </section>
  );
}

function WalkerView({ game, hidden }: { game: GameState; hidden: boolean }) {
  const visible = visibleWalkerPoints(game.maze.cells, game.position);
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
              {isCenter ? <span className="local-walker" key={`w-${game.position.r}-${game.position.c}`}>W</span> : null}
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
              {isWalker ? <span className="spectator-walker" key={`w-${game.position.r}-${game.position.c}`}>W</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MazeViewport({ game, showFullMap, showCaption = true }: { game: GameState; showFullMap: boolean; showCaption?: boolean }) {
  return (
    <div className="map-viewport">
      <div className="map-stage-shell">
        <div className="map-stage">
          <WalkerView game={game} hidden={showFullMap} />
          <SpectatorMap game={game} hidden={!showFullMap} />
        </div>
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
      {showCaption ? (
        <p className="map-mode-caption">
          {showFullMap
            ? "Spectator mode: the complete map and actual position are never shown to Walker."
            : "Walls block sight; Walker has no absolute coordinates or complete map."}
        </p>
      ) : null}
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

function ThoughtCard({
  game,
  isThinking = false,
}: {
  game: GameState;
  isThinking?: boolean;
}) {
  return (
    <div className="agent-card thought-card">
      <div className="card-head">
        <div className="agent-name-wrap">
          <PanelLabel>AGENT OUTPUT</PanelLabel>
          <div className="thought-title-row">
            <h2>Walker&apos;s reasoning log</h2>
            <span className="thought-info">
              <button className="thought-info-button" type="button" aria-label="About Walker&apos;s reasoning log" aria-describedby="walker-reasoning-description">i</button>
              <span className="thought-tooltip" id="walker-reasoning-description" role="tooltip">A concise explanation Walker provides each turn—not the model&apos;s hidden chain of thought.</span>
            </span>
          </div>
        </div>
      </div>
      <ThoughtStream history={game.history} isThinking={isThinking} />
    </div>
  );
}

function TextLoopValue({ value }: { value: string }) {
  return (
    <span className="text-loop-value" aria-live="polite">
      <span className="text-loop-value-item" key={value}>{value}</span>
    </span>
  );
}

function TurnOutputThread({ thoughts, activeTurn }: { thoughts: WalkerTurn[]; activeTurn: number | null }) {
  return (
    <aside className="turn-output-thread" aria-live="polite">
      {!activeTurn ? (
        <article className="turn-thread-card is-active is-idle-card">
          <span className="turn-output-label">WALKER OUTPUT</span>
          <p>Waiting for the first recorded turn…</p>
          <span className="turn-output-meta">RECORDED DEMO</span>
        </article>
      ) : null}
      {thoughts.map((thought) => {
        const distance = activeTurn ? thought.turn - activeTurn : null;
        const state = distance === 0
          ? "is-active"
          : distance === -1
            ? "is-before"
            : distance === 1 || (!activeTurn && thought.turn === 1)
              ? "is-after"
              : distance === 2 || (!activeTurn && thought.turn > 1)
                ? "is-below"
                : "is-hidden";
        const directionLabel = DIRECTIONS.find((item) => item.key === thought.direction)?.label;
        const threadLabel = `TURN ${String(thought.turn).padStart(2, "0")} · MOVE ${directionLabel?.toUpperCase() ?? "—"}`;
        return (
          <article className={`turn-thread-card ${state}`} key={thought.turn} data-thread-label={threadLabel} aria-hidden={state !== "is-active"}>
            <span className="turn-output-label">WALKER OUTPUT</span>
            <p>{thought.reasoning}</p>
            <span className="turn-output-meta">{threadLabel}</span>
          </article>
        );
      })}
    </aside>
  );
}

function WalkerCard({ game, showFullMap, onToggleFullMap, showTurnOutput = false, showMapCaption = true }: { game: GameState; showFullMap: boolean; onToggleFullMap: () => void; showTurnOutput?: boolean; showMapCaption?: boolean }) {
  const lastThought = game.history.at(-1);
  const reportedPosition = lastThought?.believedPosition ?? { x: 0, y: 0 };
  const expectedReportedPosition = relativePositionAtObservation(game.history, game.history.length - 1);
  const coordinateIsConsistent = reportedPosition.x === expectedReportedPosition.x && reportedPosition.y === expectedReportedPosition.y;

  return (
    <article className="agent-card walker-card">
      <div className="card-head">
        <div className="agent-name-wrap"><PanelLabel>WALKER VIEW</PanelLabel><h2>The Local Explorer</h2></div>
        <div className="card-head-actions">
          <button className="button view-toggle" type="button" aria-pressed={showFullMap} onClick={onToggleFullMap}>
            {showFullMap ? "Show Walker view" : "Show full map"}
          </button>
          <span className={`visibility-tag ${showFullMap ? "spectator-tag" : "local-tag"}`}>{showFullMap ? "SPECTATOR" : "LINE OF SIGHT"}</span>
        </div>
      </div>
      <div className={`walker-card-body ${showTurnOutput ? "has-turn-output" : ""}`}>
        <div className="walker-card-main">
          <div className="map-heading">
            <span>Maze {game.maze.seed} · optimal {game.maze.routeLength} steps</span>
          </div>
          <MazeViewport game={game} showFullMap={showFullMap} showCaption={showMapCaption} />
          <div className="action-readout">
            <div><span className="readout-label">LAST ACTION</span><strong><TextLoopValue value={game.lastAction ? `Move ${DIRECTIONS.find((item) => item.key === game.lastAction)?.label}` : "—"} /></strong></div>
            <div><span className="readout-label">COORDINATE</span><strong className={!lastThought || coordinateIsConsistent ? "match" : "drift"}><TextLoopValue value={lastThought ? `(${reportedPosition.x}, ${reportedPosition.y})` : "(0, 0)"} /></strong></div>
            <div><span className="readout-label">STEPS TAKEN</span><strong><TextLoopValue value={String(game.turn).padStart(2, "0")} /></strong></div>
          </div>
          <div className="coordinate-readout">
            <span className="readout-label">COORDINATE STATUS</span>
            <strong className={!lastThought || coordinateIsConsistent ? "match" : "drift"}>{lastThought ? (coordinateIsConsistent ? "Consistent" : "Drift detected") : "Origin"}</strong>
            <em>{lastThought ? "relative position check" : "awaiting first turn"}</em>
          </div>
        </div>
        {showTurnOutput ? <TurnOutputThread thoughts={DEMO_REPLAY_TURNS} activeTurn={lastThought?.turn ?? null} /> : null}
      </div>
    </article>
  );
}

function BenchmarkIntro() {
  return (
    <section className="benchmark-section" aria-labelledby="benchmark-heading">
      <div className="benchmark-panel">
        <div className="benchmark-panel-heading">
          <PanelLabel>THE BENCHMARK</PanelLabel>
          <h2 id="benchmark-heading">A memory test with no map.</h2>
        </div>
        <div className="benchmark-copy">
          <p>Echo Maze is an observable AI-agent game about navigating without a map. The benchmark asks one Walker to find the exit from a generated maze while it can only see along open corridors until a wall blocks its view.</p>
          <p>On every turn, the Walker interprets that limited observation, remembers what happened earlier in the current conversation, maintains its own relative coordinate system, and chooses the next move.</p>
          <p>Every run stays reviewable. Successful and failed moves are recorded so a replay can show where the Walker built an accurate map, became confused, recovered, or failed.</p>
          <a className="benchmark-link" href="/replay">Review a complete run <span aria-hidden="true">↗</span></a>
        </div>
        <div className="benchmark-principles" aria-label="Benchmark principles">
          <article>
            <span>01 / INPUT</span>
            <h3>Partial observability</h3>
            <p>Walls hide everything beyond the corridor the Walker can currently see.</p>
          </article>
          <article>
            <span>02 / MEMORY</span>
            <h3>One conversation</h3>
            <p>No full map, route-finding tool, or external notebook is available.</p>
          </article>
          <article>
            <span>03 / EVIDENCE</span>
            <h3>Replayable runs</h3>
            <p>Compare the agent&apos;s stated model of the world with the actual maze.</p>
          </article>
        </div>
      </div>
    </section>
  );
}

export function LandingPage() {
  const [showFullMap, setShowFullMap] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timer = window.setInterval(() => {
      setFrameIndex((index) => (index + 1) % DEMO_REPLAY_FRAMES.length);
    }, 520);
    return () => window.clearInterval(timer);
  }, []);

  const frame = DEMO_REPLAY_FRAMES[frameIndex] ?? DEMO_REPLAY_FRAMES[0];

  return (
    <main className="echo-app landing-page">
      <AppNavigation currentPath="/" />
      <div className="page-hero">
        <IntroSection mode="replay" showReplayLink />
      </div>

      <section className="landing-demo" aria-label="Featured Walker replay">
        <div className="landing-demo-card">
          <WalkerCard
            game={frame.game}
            showFullMap={showFullMap}
            onToggleFullMap={() => setShowFullMap((value) => !value)}
            showTurnOutput
            showMapCaption={false}
          />
        </div>
      </section>

      <BenchmarkIntro />
    </main>
  );
}

function WalkerPanels({
  game,
  showFullMap,
  onToggleFullMap,
  isThinking = false,
}: {
  game: GameState;
  showFullMap: boolean;
  onToggleFullMap: () => void;
  isThinking?: boolean;
}) {
  return (
    <section className="agent-grid solo-grid">
      <ThoughtCard game={game} isThinking={isThinking} />
      <WalkerCard game={game} showFullMap={showFullMap} onToggleFullMap={onToggleFullMap} />
    </section>
  );
}

export function LiveLab() {
  const [game, setGame] = useState<GameState>(() => makeInitialGame(true));
  const [autoRun, setAutoRun] = useState(false);
  const [showFullMap, setShowFullMap] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  const [replayStatus, setReplayStatus] = useState<ReplayStatus>("starting");
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
        observation: observeWalkerCell(
          snapshot.maze.cells,
          snapshot.maze.exit,
          snapshot.position,
          snapshot.lastAction,
          snapshot.lastResult,
        ),
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

  const statusLabel = game.status === "won" ? "Exit found" : game.status === "ready" ? "Ready" : "Exploring";
  const statusTone = game.status === "won" ? "success" : game.status === "ready" ? "idle" : "live";

  return (
    <main className="echo-app lab-page">
      <div className="page-hero">
        <Masthead mode="lab" onNewMaze={newMaze} />
        <IntroSection mode="lab" />
      </div>

      <div className="lab-workspace">
        <section className="control-bar">
          <div className="control-info">
            <div className="run-status">
              <StatusDot status={statusTone} />
              <span>{statusLabel}</span>
            </div>
            <div className="phase-track" aria-label="Turn phases"><span className={game.phase === "walker_think" ? "is-active" : ""}>1 · Observe & reason</span><i>→</i><span className={game.phase === "walker_move" ? "is-active" : ""}>2 · Move & remember outcome</span></div>
          </div>
          <div className="control-actions">
            <span className="turn-counter"><strong>{String(game.turn).padStart(2, "0")}</strong> turns</span>
            <button className="button button-export" onClick={() => void exportReplay()} disabled={!replayRunId || replayStatus === "starting"}>Export replay</button>
            <button className="button button-step" onClick={() => void step()} disabled={game.status === "won" || isThinking}>{isThinking ? "Walker thinking…" : game.phase === "walker_think" ? "Ask Walker" : "Move Walker"} <span>→</span></button>
            <button className={`button button-run ${autoRun ? "is-running" : ""}`} onClick={() => setAutoRun((value) => !value)} disabled={game.status === "won"}><span className="play-icon">{autoRun ? "Ⅱ" : "▶"}</span>{autoRun ? "Pause" : "Auto-run"}</button>
          </div>
        </section>

        {agentError ? <div className="agent-error" role="alert"><strong>Agent call failed</strong><span>{agentError}</span><button type="button" onClick={() => setAgentError(null)}>Dismiss</button></div> : null}

        <WalkerPanels
          game={game}
          showFullMap={showFullMap}
          onToggleFullMap={() => setShowFullMap((value) => !value)}
          isThinking={isThinking}
        />
      </div>

      <footer className="footer-note"><span>Echo Maze · solo walker · gpt-5.6 luna</span><span>minimum optimal route {MIN_ROUTE_LENGTH}</span></footer>
    </main>
  );
}

export function ReplayHome() {
  const [showFullMap, setShowFullMap] = useState(false);
  const [replayRuns, setReplayRuns] = useState<ReplayRunSummary[]>([DEMO_REPLAY_SUMMARY]);
  const [selectedReplayId, setSelectedReplayId] = useState(DEMO_REPLAY_DETAIL.run.id);
  const [playbackFrames, setPlaybackFrames] = useState<ReplayFrame[]>(DEMO_REPLAY_FRAMES);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(2);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [isReplayLoading, setIsReplayLoading] = useState(false);
  const [replayLibraryError, setReplayLibraryError] = useState<string | null>(null);
  const [isReplayLibraryExpanded, setIsReplayLibraryExpanded] = useState(true);
  const initialReplayLoadedRef = useRef(true);

  const refreshReplayRuns = useCallback(async () => {
    try {
      const response = await fetch("/api/replays");
      if (!response.ok) throw new Error("Could not load saved runs.");
      const data = await response.json() as { runs?: ReplayRunSummary[] };
      const storedRuns = data.runs ?? [];
      setReplayRuns([DEMO_REPLAY_SUMMARY, ...storedRuns.filter((run) => run.id !== DEMO_REPLAY_SUMMARY.id)]);
      setReplayLibraryError(null);
    } catch (error) {
      setReplayLibraryError(error instanceof Error ? error.message : "Could not load saved runs.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshReplayRuns(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshReplayRuns]);

  const loadReplay = useCallback(async (runId: string) => {
    setSelectedReplayId(runId);
    setIsReplayPlaying(false);
    setPlaybackIndex(0);
    if (!runId) {
      setPlaybackFrames([]);
      return;
    }
    setIsReplayLoading(true);
    setReplayLibraryError(null);
    if (runId === DEMO_REPLAY_DETAIL.run.id) {
      setPlaybackFrames(DEMO_REPLAY_FRAMES);
      setIsReplayLoading(false);
      return;
    }
    try {
      const response = await fetch(`/api/replays?id=${encodeURIComponent(runId)}&compact=1`);
      if (!response.ok) throw new Error("Could not load this replay.");
      const detail = await response.json() as ReplayDetail;
      setPlaybackFrames(buildReplayFrames(detail));
      setPlaybackIndex(0);
    } catch (error) {
      setPlaybackFrames([]);
      setReplayLibraryError(error instanceof Error ? error.message : "Could not load this replay.");
    } finally {
      setIsReplayLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialReplayLoadedRef.current || replayRuns.length === 0) return;
    initialReplayLoadedRef.current = true;
    void loadReplay(replayRuns[0].id);
  }, [loadReplay, replayRuns]);

  useEffect(() => {
    if (!isReplayPlaying || playbackFrames.length < 2) return undefined;
    if (playbackIndex >= playbackFrames.length - 1) {
      const timer = window.setTimeout(() => setIsReplayPlaying(false), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(
      () => setPlaybackIndex((index) => Math.min(index + 1, playbackFrames.length - 1)),
      700 / playbackSpeed,
    );
    return () => window.clearTimeout(timer);
  }, [isReplayPlaying, playbackFrames.length, playbackIndex, playbackSpeed]);

  const playbackFrame = playbackFrames[playbackIndex] ?? null;
  const isReplayMode = Boolean(selectedReplayId && playbackFrame);
  const selectedReplay = replayRuns.find((run) => run.id === selectedReplayId) ?? null;

  function toggleReplayPlayback() {
    if (!isReplayPlaying && playbackIndex >= playbackFrames.length - 1) setPlaybackIndex(0);
    setIsReplayPlaying((value) => !value);
  }

  async function exportSelectedReplay() {
    if (!selectedReplayId || !selectedReplay) return;
    try {
      let replay: unknown = DEMO_REPLAY_DETAIL;
      if (selectedReplayId !== DEMO_REPLAY_DETAIL.run.id) {
        const response = await fetch(`/api/replays?id=${encodeURIComponent(selectedReplayId)}`);
        if (!response.ok) throw new Error("Could not export this replay.");
        replay = await response.json();
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(replay, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `echo-maze-solo-${selectedReplay.maze_seed}-${selectedReplay.id.slice(0, 8)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setReplayLibraryError(error instanceof Error ? error.message : "Could not export this replay.");
    }
  }

  return (
    <main className="echo-app replay-page replay-workspace-page">
      <AppNavigation currentPath="/replay" />
      <div className={`replay-workspace ${isReplayLibraryExpanded ? "is-library-expanded" : "is-library-collapsed"}`}>
        <div className="replay-left-column">
          <section
            id="replay-library-card"
            className={`replay-console replay-home-console ${isReplayLibraryExpanded ? "is-expanded" : "is-collapsed"}`}
            aria-label="Replay library"
          >
            <div className="replay-console-head">
              <div><PanelLabel>REPLAY LIBRARY</PanelLabel><h2>Review any recorded run</h2></div>
              <div className="replay-head-actions">
                <span className="replay-state replay-recording">Replay only</span>
              </div>
            </div>
            <div className={`replay-library-panel ${isReplayLibraryExpanded ? "is-visible" : ""}`} aria-hidden={!isReplayLibraryExpanded}>
              <div className="replay-library-panel-inner">
                <div className="replay-console-body">
                  <div className="replay-library-actions">
                    <button className="button button-export" type="button" onClick={() => void exportSelectedReplay()} disabled={!isReplayMode || isReplayLoading}>Export replay</button>
                    <button className="button replay-refresh" type="button" onClick={() => void refreshReplayRuns()}>Refresh</button>
                  </div>
                  <div className="replay-controls">
                    <label className="replay-field replay-run-field">
                      <span>Run · {replayRuns.length} saved</span>
                      <select value={selectedReplayId} onChange={(event) => void loadReplay(event.target.value)} disabled={isReplayLoading}>
                        <option value="">Select a saved run</option>
                        {replayRuns.map((run) => (
                          <option value={run.id} key={run.id}>
                            {run.maze_seed} · {run.status.toUpperCase()} · {run.max_turn ?? 0} turns{run.is_demo ? " · featured demo" : run.had_error ? " · error logged" : ""}
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
                        onClick={toggleReplayPlayback}
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
                      {isReplayMode ? <button type="button" onClick={() => void loadReplay("")}>Clear selection</button> : <span />}
                    </div>
                  </div>
                  {replayLibraryError ? <p className="replay-library-error">{replayLibraryError}</p> : null}
                </div>
              </div>
            </div>
            <div className={`replay-collapsed-panel ${isReplayLibraryExpanded ? "" : "is-visible"}`} aria-hidden={isReplayLibraryExpanded}>
              <div className="replay-collapsed-panel-inner">
                <div className="replay-collapsed-summary">
                  <div className="replay-collapsed-copy">
                    <span>{selectedReplay ? `${selectedReplay.maze_seed} · ${selectedReplay.status.toUpperCase()} · ${selectedReplay.max_turn ?? 0} turns` : "No run selected"}</span>
                    <span>{isReplayMode ? `Frame ${playbackIndex + 1} / ${playbackFrames.length}` : "Open library to choose a run"}</span>
                  </div>
                  <button
                    className={`button replay-collapsed-play ${isReplayPlaying ? "is-playing" : ""}`}
                    type="button"
                    tabIndex={isReplayLibraryExpanded ? -1 : 0}
                    aria-label={isReplayPlaying ? "Pause replay" : "Play replay"}
                    disabled={!isReplayMode || isReplayLoading || playbackFrames.length < 2}
                    onClick={toggleReplayPlayback}
                  >
                    {isReplayLoading ? "Loading…" : isReplayPlaying ? "Ⅱ Pause" : "▶ Play"}
                  </button>
                </div>
              </div>
            </div>
          </section>

          {playbackFrame ? (
            <>
              <div className="replay-card-toggle-gap">
                <button
                  className={`replay-library-toggle ${isReplayLibraryExpanded ? "is-expanded" : "is-collapsed"}`}
                  type="button"
                  aria-controls="replay-library-card"
                  aria-expanded={isReplayLibraryExpanded}
                  aria-label={isReplayLibraryExpanded ? "Collapse replay library" : "Expand replay library"}
                  onClick={() => setIsReplayLibraryExpanded((value) => !value)}
                >
                  <span aria-hidden="true">
                    <svg viewBox="0 0 20 20" focusable="false">
                      <path d="m4 7 6 6 6-6" />
                    </svg>
                  </span>
                </button>
              </div>
              <ThoughtCard game={playbackFrame.game} />
            </>
          ) : null}
        </div>

        {playbackFrame ? (
          <WalkerCard
            game={playbackFrame.game}
            showFullMap={showFullMap}
            onToggleFullMap={() => setShowFullMap((value) => !value)}
          />
        ) : (
          <section className="replay-empty-state replay-view-empty" aria-live="polite">
            <PanelLabel>NO RUN SELECTED</PanelLabel>
            <h2>Select a saved run to inspect</h2>
            <p>The home view is read-only. Choose a recorded run above to scrub its observations, decisions, and outcomes.</p>
          </section>
        )}
      </div>

    </main>
  );
}
