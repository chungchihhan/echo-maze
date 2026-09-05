"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  DIRECTIONS,
  MIN_ROUTE_LENGTH,
  canMove,
  generateMaze,
  getNeighbor,
  samePoint,
  seededRandom,
  walkerObservation as observeWalkerCell,
} from "../lib/maze/index.js";
import type { DirectionKey, Maze, MoveResult, Point } from "../lib/maze/types.js";
import { DEMO_REPLAY_DETAIL, DEMO_REPLAY_PROVENANCE, type DemoReplayDetail } from "./demo-replay";
import { HeroMaze } from "./hero-maze";
import { MazeSightLayer } from "./maze-sight";
import { MazeStructure } from "./maze-structure";
import { GridWalkerMarker } from "./walker-marker";

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
  spl?: number;
  batch_id?: string;
  reasoning_effort?: string | null;
  successful_moves?: number;
  wall_hits?: number;
  featured?: boolean;
  homepage_order?: number;
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
type ReplayCueIndex = 0 | 1 | 2 | 3;

const HERO_MAZES = [
  generateMaze(seededRandom("ECHO-MAZE-HERO-01"), "HERO01"),
  generateMaze(seededRandom("ECHO-MAZE-HERO-02"), "HERO02"),
  generateMaze(seededRandom("ECHO-MAZE-HERO-03"), "HERO03"),
  generateMaze(seededRandom("ECHO-MAZE-HERO-04"), "HERO04"),
  generateMaze(seededRandom("ECHO-MAZE-HERO-05"), "HERO05"),
];
const LANDING_STAGE_HOLD_MS = [2200, 1200, 0, 1800, 900] as const;
const LANDING_STREAM_CHARACTER_MS = 22;
const LANDING_READOUT_DELAYS_MS = {
  turn: 0,
  lastAction: 200,
  moves: 400,
  wallHits: 600,
} as const;

function subscribeToReducedMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function reducedMotionSnapshot() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      const direction = typeof payload.direction === "string" ? payload.direction : payload.action;
      if (typeof direction !== "string" || !DIRECTIONS.some((item) => item.key === direction)) continue;
      const believed = replayPayload(payload.believedPosition ?? payload.estimatedPosition);
      const reasoning = typeof payload.reasoning === "string"
        ? payload.reasoning
        : typeof payload.notes === "string"
          ? payload.notes
          : "Navigation notes unavailable.";
      const entry: WalkerTurn = {
        turn: typeof payload.turn === "number" ? payload.turn : state.turn + 1,
        observation: pendingObservation,
        observationSummary: typeof payload.observationSummary === "string" ? payload.observationSummary : "Observation unavailable.",
        reasoning,
        believedPosition: {
          x: typeof believed.x === "number" ? believed.x : 0,
          y: typeof believed.y === "number" ? believed.y : 0,
        },
        coordinateNote: typeof payload.coordinateNote === "string" ? payload.coordinateNote : reasoning,
        direction: direction as DirectionKey,
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
const DEMO_REPLAY_TURNS = [...DEMO_REPLAY_FRAMES.reduce((turns, frame) => {
  const thought = frame.game.history.at(-1);
  if (thought) turns.set(thought.turn, thought);
  return turns;
}, new Map<number, WalkerTurn>()).values()];

type LandingReplayTurn = { decisionGame: GameState; resultGame: GameState; thought: WalkerTurn };

function buildLandingReplayTurns(frames: ReplayFrame[]): LandingReplayTurn[] {
  return frames.flatMap((frame, frameIndex) => {
    const thought = frame.game.history.at(-1);
    if (frame.game.phase !== "walker_move" || !thought) return [];
    const resultFrame = frames.slice(frameIndex + 1).find((candidate) => {
      const resultThought = candidate.game.history.at(-1);
      return resultThought?.turn === thought.turn && resultThought.result !== null;
    });
    return [{ decisionGame: frame.game, resultGame: resultFrame?.game ?? frame.game, thought }];
  });
}

const DEMO_LANDING_REPLAY_TURNS = buildLandingReplayTurns(DEMO_REPLAY_FRAMES);

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
  reasoning_effort: "low",
  is_demo: true,
};

function replayConfigurationKey(run: ReplayRunSummary) {
  return `${run.model}::${run.reasoning_effort ?? "unspecified"}`;
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
        <HeroMaze mazes={HERO_MAZES} />
        <div className="intro-note">
          <p>{isLab ? <>No map. No route tool. No notebook.<br />Only observations, decisions, and outcomes from this run.</> : <>Replay the decisions, outcomes, and memory<br />from a completed Walker run.</>}</p>
        </div>
      </div>
    </section>
  );
}

function WalkerView({ game, hidden }: { game: GameState; hidden: boolean }) {
  const exitVisible = observeWalkerCell(game.maze.cells, game.maze.exit, game.position).exitVisible;
  return (
    <>
      <div className={`map-layer walker-light-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
        {!hidden ? <MazeSightLayer key={game.maze.seed} maze={game.maze} position={game.position} /> : null}
      </div>
      <div className={`map-layer walker-structure-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
        <MazeStructure maze={game.maze} ariaLabel="Hidden maze with Walker light" className="walker-light-grid" showExit={exitVisible}>
          <GridWalkerMarker position={game.position} size={game.maze.cells.length} />
        </MazeStructure>
      </div>
    </>
  );
}

function SpectatorMap({ game, hidden }: { game: GameState; hidden: boolean }) {
  return (
    <div className={`map-layer spectator-map-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
      <MazeStructure maze={game.maze} ariaLabel="Complete maze spectator view" showStart showExit>
        <GridWalkerMarker position={game.position} size={game.maze.cells.length} />
      </MazeStructure>
    </div>
  );
}

function MazeViewport({ game, showFullMap, showCaption = true }: { game: GameState; showFullMap: boolean; showCaption?: boolean }) {
  return (
    <div className="map-viewport">
      <div className="map-stage-shell">
        <div className="map-stage maze-grid-stage">
          <WalkerView game={game} hidden={showFullMap} />
          <SpectatorMap game={game} hidden={!showFullMap} />
        </div>
      </div>
      <div className="map-legend-slot" aria-hidden="true">
        <div className={`map-legend mode-legend ${showFullMap ? "is-hidden" : "is-visible"}`}>
          <span><i className="legend-swatch swatch-light" />Walker light</span>
          <span><i className="legend-swatch swatch-hidden-area" />Hidden area</span>
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
            : "Darkness hides the maze; Walker light follows wall-blocked sightlines."}
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

function TextLoopValue({ value, delayMs = 0, animationKey }: { value: string; delayMs?: number; animationKey?: string | number }) {
  return (
    <span className="text-loop-value" aria-live="polite">
      <span className="text-loop-value-item" key={`${animationKey ?? value}-${value}`} style={delayMs ? { animationDelay: `${delayMs}ms` } : undefined}>{value}</span>
    </span>
  );
}

function TurnOutputThread({ thoughts, activeTurn, activeResult }: { thoughts: WalkerTurn[]; activeTurn: number | null; activeResult: MoveResult | null }) {
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
        const result = distance === 0 ? activeResult : thought.result;
        return (
          <article className={`turn-thread-card ${state}`} key={thought.turn} data-thread-label={threadLabel} aria-hidden={state !== "is-active"}>
            <span className="turn-output-label">WALKER OUTPUT</span>
            <p>{thought.reasoning}</p>
            <div className="turn-output-result">
              <span>ENVIRONMENT RESULT</span>
              <strong className={result === "blocked" ? "is-blocked" : result === null ? "is-pending" : ""}>
                {result === "blocked" ? "Blocked — stayed in place" : result === "moved" ? "Move succeeded" : "Awaiting move"}
              </strong>
            </div>
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
            {showFullMap ? "Show Walker light" : "Reveal full maze"}
          </button>
          <span className={`visibility-tag ${showFullMap ? "spectator-tag" : "local-tag"}`}>{showFullMap ? "SPECTATOR" : "LINE OF SIGHT"}</span>
        </div>
      </div>
      <div className={`walker-card-body ${showTurnOutput ? "has-turn-output" : ""}`}>
        <div className="walker-card-main">
          <div className="map-heading">
            <span>Maze {game.maze.seed} · shortest path {game.maze.routeLength} moves</span>
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
            <em>{lastThought ? (lastThought.result === null ? "estimate before action" : "awaiting next estimate") : "awaiting first turn"}</em>
          </div>
        </div>
        {showTurnOutput ? <TurnOutputThread thoughts={DEMO_REPLAY_TURNS} activeTurn={lastThought?.turn ?? null} activeResult={lastThought?.result ?? null} /> : null}
      </div>
    </article>
  );
}

function StreamingAgentOutput({ text, stage }: { text: string; stage: number }) {
  const [visibleCharacters, setVisibleCharacters] = useState(0);
  const reduceMotion = useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);

  useEffect(() => {
    if (stage !== 2 || reduceMotion) return;

    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const elapsed = performance.now() - startedAt;
      setVisibleCharacters(Math.min(text.length, Math.floor(elapsed / LANDING_STREAM_CHARACTER_MS)));
    }, 30);
    return () => window.clearInterval(timer);
  }, [reduceMotion, stage, text]);

  const renderedCharacters = stage < 2 ? 0 : stage > 2 || reduceMotion ? text.length : visibleCharacters;

  return (
    <p className="landing-streaming-copy" aria-label={text}>
      <span aria-hidden="true">{text.slice(0, renderedCharacters)}</span>
      {stage === 2 && renderedCharacters < text.length ? <i className="streaming-caret" aria-hidden="true" /> : null}
    </p>
  );
}

function landingStageClass(stage: number, section: number) {
  if (stage === section) return "is-active";
  if (stage > section) return "is-complete";
  return "is-pending";
}

function LandingReplayStage({
  decisionGame,
  mapGame,
  thought,
  stage,
  showFullMap,
  onToggleFullMap,
}: {
  decisionGame: GameState;
  mapGame: GameState;
  thought: WalkerTurn;
  stage: number;
  showFullMap: boolean;
  onToggleFullMap: () => void;
}) {
  const reportedPosition = thought.believedPosition ?? { x: 0, y: 0 };
  const lastActionLabel = decisionGame.lastAction
    ? DIRECTIONS.find((item) => item.key === decisionGame.lastAction)?.label
    : null;
  const actionLabel = DIRECTIONS.find((item) => item.key === thought.direction)?.label ?? "—";

  return (
    <div className="landing-replay-stage">
      <header className="landing-replay-head">
        <div>
          <PanelLabel>RECORDED WALKER RUN</PanelLabel>
          <h2>One turn at a time.</h2>
          <p>Maze {decisionGame.maze.seed} · shortest path {decisionGame.maze.routeLength} moves</p>
        </div>
        <div className="landing-replay-actions">
          <button className="button view-toggle" type="button" aria-pressed={showFullMap} onClick={onToggleFullMap}>
            {showFullMap ? "Show Walker light" : "Reveal full maze"}
          </button>
        </div>
      </header>

      <div className="landing-replay-body">
        <div className="landing-maze-panel">
          <MazeViewport game={mapGame} showFullMap={showFullMap} showCaption={false} />
        </div>

        <div className="landing-output-panel">
          <div className="landing-output-row landing-turn-row landing-context-row">
            <div><span>TURN</span><strong><TextLoopValue value={String(thought.turn).padStart(2, "0")} animationKey={thought.turn} delayMs={LANDING_READOUT_DELAYS_MS.turn} /></strong></div>
            <div><span>LAST ACTION</span><strong><TextLoopValue value={lastActionLabel ? `MOVE ${lastActionLabel.toUpperCase()}` : "—"} animationKey={thought.turn} delayMs={LANDING_READOUT_DELAYS_MS.lastAction} /></strong></div>
          </div>
          <div className="landing-output-row landing-metrics-row landing-context-row">
            <div><span>MOVES</span><strong><TextLoopValue value={String(Math.max(0, decisionGame.turn - decisionGame.collisions)).padStart(2, "0")} animationKey={thought.turn} delayMs={LANDING_READOUT_DELAYS_MS.moves} /></strong></div>
            <div><span>WALL HITS</span><strong><TextLoopValue value={String(decisionGame.collisions).padStart(2, "0")} animationKey={thought.turn} delayMs={LANDING_READOUT_DELAYS_MS.wallHits} /></strong></div>
          </div>
          <div className={`landing-exploring ${stage === 0 ? "is-active" : "is-complete"}`}>
            <span>Exploring the maze…</span>
          </div>
          <div className={`landing-model-estimate ${landingStageClass(stage, 1)}`}>
            <span>MODEL ESTIMATE</span>
            <strong><TextLoopValue value={stage >= 1 ? `(${reportedPosition.x}, ${reportedPosition.y})` : "—"} /></strong>
          </div>
          <div className={`landing-agent-output ${landingStageClass(stage, 2)}`}>
            <span>AGENT OUTPUT</span>
            <StreamingAgentOutput key={`${decisionGame.maze.seed}-${thought.turn}`} text={thought.reasoning} stage={stage} />
          </div>
          <div className={`landing-model-action ${landingStageClass(stage, 3)}`}>
            <span>ACTION</span>
            <strong><TextLoopValue value={stage >= 3 ? `MOVE ${actionLabel.toUpperCase()}` : "—"} /></strong>
          </div>
        </div>
      </div>
    </div>
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
  const [landingTurns, setLandingTurns] = useState<LandingReplayTurn[]>(DEMO_LANDING_REPLAY_TURNS);
  const [publishedRuns, setPublishedRuns] = useState<ReplayRunSummary[]>([]);
  const [publishedRunIndex, setPublishedRunIndex] = useState(0);
  const [turnIndex, setTurnIndex] = useState(0);
  const [stage, setStage] = useState(0);
  const publishedReplayCache = useRef(new Map<string, LandingReplayTurn[]>());
  const replayTurn = landingTurns[turnIndex] ?? landingTurns[0] ?? DEMO_LANDING_REPLAY_TURNS[0];
  const mapGame = stage >= 3 ? replayTurn.resultGame : replayTurn.decisionGame;
  const publishedRun = publishedRuns[publishedRunIndex];

  useEffect(() => {
    const controller = new AbortController();
    const loadPublishedIndex = async () => {
      try {
        const indexResponse = await fetch("/replay-data/index.json", { signal: controller.signal });
        if (!indexResponse.ok) throw new Error("Could not load published replay index.");
        const data = await indexResponse.json() as { runs?: ReplayRunSummary[] };
        const playableRuns = (data.runs ?? [])
          .filter((run) => run.featured !== false && (run.max_turn ?? 0) > 1)
          .sort((left, right) => (left.homepage_order ?? Number.MAX_SAFE_INTEGER) - (right.homepage_order ?? Number.MAX_SAFE_INTEGER));
        if (playableRuns.length === 0) throw new Error("No published replay has playable turns.");
        setPublishedRuns(playableRuns);
        setPublishedRunIndex(0);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Echo Maze homepage is using the bundled replay fallback:", error);
      }
    };

    void loadPublishedIndex();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!publishedRun) return undefined;
    const controller = new AbortController();

    const loadRun = async (run: ReplayRunSummary) => {
      const cached = publishedReplayCache.current.get(run.id);
      if (cached) return cached;
      const response = await fetch(`/replay-data/runs/${encodeURIComponent(run.id)}.json`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load published replay ${run.id}.`);
      const detail = await response.json() as ReplayDetail;
      const turns = buildLandingReplayTurns(buildReplayFrames(detail));
      if (turns.length === 0) throw new Error(`Published replay ${run.id} has no complete turns.`);
      publishedReplayCache.current.set(run.id, turns);
      return turns;
    };

    loadRun(publishedRun)
      .then((turns) => {
        if (controller.signal.aborted) return;
        setLandingTurns(turns);
        setTurnIndex(0);
        setStage(0);
        setShowFullMap(false);

        const nextRun = publishedRuns[(publishedRunIndex + 1) % publishedRuns.length];
        if (nextRun && nextRun.id !== publishedRun.id) {
          void loadRun(nextRun).catch((error) => {
            if (!controller.signal.aborted) console.warn("Could not preload the next homepage replay:", error);
          });
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.warn("Skipping an unavailable homepage replay:", error);
        setPublishedRunIndex((index) => (index + 1) % publishedRuns.length);
      });

    return () => controller.abort();
  }, [publishedRun, publishedRunIndex, publishedRuns]);

  useEffect(() => {
    const stageDelay = stage === 2
      ? Math.min(7500, Math.max(3500, replayTurn.thought.reasoning.length * LANDING_STREAM_CHARACTER_MS + 700))
      : LANDING_STAGE_HOLD_MS[stage] ?? 1000;
    const timer = window.setTimeout(() => {
      if (stage < 4) {
        setStage((current) => current + 1);
      } else if (turnIndex >= landingTurns.length - 1 && publishedRuns.length > 1) {
        setPublishedRunIndex((index) => (index + 1) % publishedRuns.length);
      } else {
        setTurnIndex((index) => (index + 1) % landingTurns.length);
        setStage(0);
      }
    }, stageDelay);
    return () => window.clearTimeout(timer);
  }, [landingTurns.length, publishedRuns.length, replayTurn.thought.reasoning.length, stage, turnIndex]);

  return (
    <main className="echo-app landing-page">
      <AppNavigation currentPath="/" />
      <div className="page-hero">
        <IntroSection mode="replay" showReplayLink />
      </div>

      <section className="landing-demo" aria-label="Featured Walker replay">
        <div className="landing-demo-card">
          <LandingReplayStage
            decisionGame={replayTurn.decisionGame}
            mapGame={mapGame}
            thought={replayTurn.thought}
            stage={stage}
            showFullMap={showFullMap}
            onToggleFullMap={() => setShowFullMap((value) => !value)}
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
  const [selectedReplayConfiguration, setSelectedReplayConfiguration] = useState(replayConfigurationKey(DEMO_REPLAY_SUMMARY));
  const [selectedReplayId, setSelectedReplayId] = useState(DEMO_REPLAY_DETAIL.run.id);
  const [playbackFrames, setPlaybackFrames] = useState<ReplayFrame[]>(DEMO_REPLAY_FRAMES);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [activeCueIndex, setActiveCueIndex] = useState<ReplayCueIndex>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(2);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [isReplayLoading, setIsReplayLoading] = useState(false);
  const [replayLibraryError, setReplayLibraryError] = useState<string | null>(null);
  const initialReplayLoadedRef = useRef(false);
  const lyricViewportRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);

  const seekPlaybackFrame = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(index, playbackFrames.length - 1));
    const nextFrame = playbackFrames[nextIndex];
    setPlaybackIndex(nextIndex);
    setActiveCueIndex(nextFrame?.game.phase === "walker_move" ? 0 : 3);
  }, [playbackFrames]);

  const loadReplay = useCallback(async (runId: string) => {
    setSelectedReplayId(runId);
    setIsReplayPlaying(false);
    setPlaybackIndex(0);
    setActiveCueIndex(0);
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
      const response = await fetch(`/replay-data/runs/${encodeURIComponent(runId)}.json`);
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

  const refreshReplayRuns = useCallback(async () => {
    try {
      const response = await fetch("/replay-data/index.json");
      if (!response.ok) throw new Error("Could not load published runs.");
      const data = await response.json() as { runs?: ReplayRunSummary[] };
      const publishedRuns = (data.runs ?? []).filter((run) => (run.max_turn ?? 0) > 0);
      if (publishedRuns.length === 0) throw new Error("No published runs are available.");
      setReplayRuns(publishedRuns);
      setReplayLibraryError(null);
      if (!initialReplayLoadedRef.current) {
        initialReplayLoadedRef.current = true;
        setSelectedReplayConfiguration(replayConfigurationKey(publishedRuns[0]));
        await loadReplay(publishedRuns[0].id);
      }
    } catch (error) {
      setReplayLibraryError(error instanceof Error ? error.message : "Could not load published runs.");
    }
  }, [loadReplay]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshReplayRuns(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshReplayRuns]);

  useEffect(() => {
    if (!isReplayPlaying || playbackFrames.length < 2) return undefined;
    const currentFrame = playbackFrames[playbackIndex];
    const hasDecision = currentFrame?.game.phase === "walker_move" && currentFrame.game.history.length > 0;

    if (hasDecision && activeCueIndex < 3) {
      const cueHoldMs = activeCueIndex === 2 ? 2200 : 1250;
      const timer = window.setTimeout(
        () => setActiveCueIndex((cue) => Math.min(3, cue + 1) as ReplayCueIndex),
        cueHoldMs / playbackSpeed,
      );
      return () => window.clearTimeout(timer);
    }

    if (playbackIndex >= playbackFrames.length - 1) {
      const timer = window.setTimeout(() => setIsReplayPlaying(false), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(
      () => {
        const nextIndex = Math.min(playbackIndex + 1, playbackFrames.length - 1);
        const nextFrame = playbackFrames[nextIndex];
        setPlaybackIndex(nextIndex);
        setActiveCueIndex(nextFrame?.game.phase === "walker_move" ? 0 : 3);
      },
      1100 / playbackSpeed,
    );
    return () => window.clearTimeout(timer);
  }, [activeCueIndex, isReplayPlaying, playbackFrames, playbackIndex, playbackSpeed]);

  const playbackFrame = playbackFrames[playbackIndex] ?? null;
  const isReplayMode = Boolean(selectedReplayId && playbackFrame);
  const selectedReplay = replayRuns.find((run) => run.id === selectedReplayId) ?? null;
  const visibleReplayRuns = replayRuns.filter((run) => run.is_demo || (run.max_turn ?? 0) > 0);
  const replayGroups = useMemo(() => {
    const configurations = new Map<string, {
      model: string;
      reasoningEffort: string | null;
      batches: Map<string, ReplayRunSummary[]>;
    }>();
    for (const run of visibleReplayRuns) {
      const key = replayConfigurationKey(run);
      const batchId = run.batch_id ?? run.id.split("--")[0] ?? "Published benchmark";
      const configuration = configurations.get(key) ?? {
        model: run.model,
        reasoningEffort: run.reasoning_effort ?? null,
        batches: new Map<string, ReplayRunSummary[]>(),
      };
      const batches = configuration.batches;
      const runs = batches.get(batchId) ?? [];
      runs.push(run);
      batches.set(batchId, runs);
      configurations.set(key, configuration);
    }
    return [...configurations.entries()].map(([key, configuration]) => ({
      key,
      model: configuration.model,
      reasoningEffort: configuration.reasoningEffort,
      batches: [...configuration.batches.entries()].map(([batchId, runs]) => ({ batchId, runs })),
    }));
  }, [visibleReplayRuns]);
  const selectedModelGroup = replayGroups.find((group) => group.key === selectedReplayConfiguration)
    ?? replayGroups[0]
    ?? null;
  const currentThought = playbackFrame?.game.history.at(-1) ?? null;
  const moveCount = playbackFrame
    ? Math.max(0, playbackFrame.game.turn - playbackFrame.game.collisions)
    : 0;
  const replayThoughts = useMemo(() => {
    const turns = new Map<number, WalkerTurn>();
    for (const frame of playbackFrames) {
      for (const thought of frame.game.history) turns.set(thought.turn, thought);
    }
    return [...turns.values()].sort((a, b) => a.turn - b.turn);
  }, [playbackFrames]);
  const lyricCues = useMemo(() => replayThoughts.flatMap((thought) => {
    const direction = DIRECTIONS.find((item) => item.key === thought.direction)?.label ?? "—";
    return [
      { turn: thought.turn, label: "ENVIRONMENT INPUT", content: thought.observationSummary, kind: "copy", result: null },
      { turn: thought.turn, label: "MODEL ESTIMATE", content: `(${thought.believedPosition?.x ?? 0}, ${thought.believedPosition?.y ?? 0})`, kind: "estimate", result: null },
      { turn: thought.turn, label: "NOTES", content: thought.reasoning, kind: "copy", result: null },
      { turn: thought.turn, label: "ACTION", content: `MOVE ${direction.toUpperCase()}`, kind: "action", result: thought.result },
    ];
  }), [replayThoughts]);
  const currentThoughtIndex = currentThought ? replayThoughts.findIndex((thought) => thought.turn === currentThought.turn) : -1;
  const activeLyricCueIndex = currentThoughtIndex < 0 ? 0 : currentThoughtIndex * 4 + activeCueIndex;
  const selectedRunIndex = visibleReplayRuns.findIndex((run) => run.id === selectedReplayId);
  const playbackProgress = playbackFrames.length > 1 ? playbackIndex / (playbackFrames.length - 1) * 100 : 0;

  useEffect(() => {
    const viewport = lyricViewportRef.current;
    const cue = viewport?.querySelector<HTMLElement>(`[data-replay-cue="${activeLyricCueIndex}"]`);
    if (!viewport || !cue) return;
    const targetTop = cue.offsetTop - viewport.clientHeight * .42 + cue.clientHeight / 2;
    viewport.scrollTo({ top: Math.max(0, targetTop), behavior: reduceMotion ? "auto" : "smooth" });
  }, [activeLyricCueIndex, lyricCues.length, reduceMotion, selectedReplayId]);

  function toggleReplayPlayback() {
    if (!isReplayPlaying && playbackIndex >= playbackFrames.length - 1) {
      setPlaybackIndex(0);
      setActiveCueIndex(0);
    }
    setIsReplayPlaying((value) => !value);
  }

  function selectAdjacentRun(offset: -1 | 1) {
    const adjacentRun = visibleReplayRuns[selectedRunIndex + offset];
    if (adjacentRun) {
      setSelectedReplayConfiguration(replayConfigurationKey(adjacentRun));
      void loadReplay(adjacentRun.id);
    }
  }

  async function exportSelectedReplay() {
    if (!selectedReplayId || !selectedReplay) return;
    try {
      let replay: unknown = DEMO_REPLAY_DETAIL;
      if (selectedReplayId !== DEMO_REPLAY_DETAIL.run.id) {
        const response = await fetch(`/replay-data/runs/${encodeURIComponent(selectedReplayId)}.json`);
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
    <main className="echo-app replay-page replay-player-page">
      <AppNavigation currentPath="/replay" />
      <section className="replay-player" aria-label="Replay player">
        <aside className="replay-player-library">
          <div className="replay-player-library-head">
            <PanelLabel>REPLAY LIBRARY</PanelLabel>
            <strong>{visibleReplayRuns.length} recorded runs</strong>
          </div>
          <div className="replay-run-list">
            <nav className="replay-model-list" aria-label="Models">
              <span className="replay-library-column-label">MODELS</span>
              {replayGroups.map((modelGroup) => (
                  <button
                    className={modelGroup.key === selectedModelGroup?.key ? "is-selected" : ""}
                    type="button"
                    key={modelGroup.key}
                    onClick={() => setSelectedReplayConfiguration(modelGroup.key)}
                    aria-pressed={modelGroup.key === selectedModelGroup?.key}
                  >
                    <strong>{modelGroup.model}</strong>
                    <small>Reasoning · {modelGroup.reasoningEffort?.toUpperCase() ?? "NOT SPECIFIED"}</small>
                  </button>
                ))}
            </nav>
            <div className="replay-model-runs">
              <span className="replay-library-column-label">RUNS</span>
              {selectedModelGroup?.batches.map((batch) => (
                  <div className="replay-batch-group" key={batch.batchId}>
                    {batch.runs.map((run) => {
                      const mazeLabel = run.maze_seed.replace("echo-maze-bench-v0-", "").replace(/-(\d+)$/, " $1").replaceAll("-", " ");
                      return (
                        <button
                          className={`replay-run-item ${run.id === selectedReplayId ? "is-selected" : ""}`}
                          type="button"
                          key={run.id}
                          onClick={() => {
                            setSelectedReplayConfiguration(replayConfigurationKey(run));
                            void loadReplay(run.id);
                          }}
                          disabled={isReplayLoading}
                          aria-current={run.id === selectedReplayId ? "true" : undefined}
                        >
                          <span className="replay-run-copy">
                            <strong>{mazeLabel}</strong>
                            <small>{run.status.replaceAll("_", " ")}</small>
                          </span>
                          <span className="replay-run-turns"><strong>{run.max_turn ?? 0}</strong><small>turns</small></span>
                        </button>
                      );
                    })}
                  </div>
                ))}
            </div>
          </div>
          <button className="replay-library-refresh" type="button" onClick={() => void refreshReplayRuns()}>Refresh library</button>
          {replayLibraryError ? <p className="replay-library-error">{replayLibraryError}</p> : null}
        </aside>

        <header className="replay-now-playing">
          <div>
            <PanelLabel>NOW PLAYING</PanelLabel>
            <h1>{selectedReplay?.model ?? "Select a replay"}</h1>
          </div>
          <div className="replay-now-playing-meta">
            <strong>{selectedReplay?.maze_seed ?? "No maze selected"}</strong>
            <span>{selectedReplay ? `${selectedReplay.status.replaceAll("_", " ")} · shortest path ${playbackFrame?.game.maze.routeLength ?? "—"} moves` : "Choose a run from the library"}</span>
          </div>
        </header>

        <div className="replay-player-main">
          <div className="replay-player-main-inner">
            {playbackFrame ? (
              <section className="replay-player-maze" aria-label="Maze playback">
                <MazeViewport game={playbackFrame.game} showFullMap={showFullMap} showCaption={false} />
              </section>
            ) : (
              <section className="replay-player-maze replay-player-empty"><span>Select a run</span></section>
            )}

            <aside className="replay-player-output" aria-live="polite">
          <div className="replay-output-heading">
            <PanelLabel>AGENT OUTPUT</PanelLabel>
            <span>{isReplayLoading ? "Loading…" : `Turn ${String(currentThought?.turn ?? 0).padStart(2, "0")}`}</span>
          </div>
          <div className="replay-output-metrics">
            <div><span>TURN</span><strong>{String(playbackFrame?.game.turn ?? 0).padStart(2, "0")}</strong></div>
            <div><span>MOVES</span><strong>{String(moveCount).padStart(2, "0")}</strong></div>
            <div><span>WALL HITS</span><strong>{String(playbackFrame?.game.collisions ?? 0).padStart(2, "0")}</strong></div>
          </div>
          <div className="replay-lyric-viewport" ref={lyricViewportRef}>
            <div className="replay-lyric-track">
              {lyricCues.length === 0 ? (
                <section className="replay-lyric-cue is-active is-copy" data-replay-cue="0">
                  <span><i>01</i>ENVIRONMENT INPUT</span>
                  <p>Waiting for the first observation.</p>
                </section>
              ) : lyricCues.map((cue, cueIndex) => {
                const cueState = cueIndex === activeLyricCueIndex ? "is-active" : cueIndex < activeLyricCueIndex ? "is-past" : "is-future";
                return (
                  <section
                    className={`replay-lyric-cue ${cueState} is-${cue.kind}`}
                    key={`${cue.turn}-${cue.label}`}
                    data-replay-cue={cueIndex}
                  >
                    <span><i>TURN {String(cue.turn).padStart(2, "0")}</i>{cue.label}</span>
                    {cue.kind === "copy" ? <p>{cue.content}</p> : <strong>{cue.content}</strong>}
                    {cue.kind === "action" ? (
                      <em className={cue.result === "blocked" ? "is-blocked" : ""}>
                        {cue.result === "blocked" ? "Blocked — stayed in place" : cue.result === "moved" ? "Move succeeded" : "Awaiting move"}
                      </em>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </div>
            </aside>
          </div>
        </div>

        <footer className="replay-player-controls">
          <div className="replay-player-timeline">
            <input
              type="range"
              min={0}
              max={Math.max(0, playbackFrames.length - 1)}
              value={Math.min(playbackIndex, Math.max(0, playbackFrames.length - 1))}
              onChange={(event) => seekPlaybackFrame(Number(event.target.value))}
              disabled={!isReplayMode || playbackFrames.length < 2}
              aria-label="Replay position"
              style={{ "--replay-progress": `${playbackProgress}%` } as CSSProperties}
            />
            <div><span>{playbackFrame?.note ?? "Select a run to begin"}</span><strong>{isReplayMode ? `${playbackIndex + 1} / ${playbackFrames.length}` : "0 / 0"}</strong></div>
          </div>
          <div className="replay-transport">
            <button type="button" onClick={() => selectAdjacentRun(-1)} disabled={selectedRunIndex <= 0} aria-label="Previous run">◀</button>
            <button className="replay-transport-play" type="button" onClick={toggleReplayPlayback} disabled={!isReplayMode || playbackFrames.length < 2} aria-label={isReplayPlaying ? "Pause replay" : "Play replay"}>{isReplayPlaying ? "Ⅱ" : "▶"}</button>
            <button type="button" onClick={() => selectAdjacentRun(1)} disabled={selectedRunIndex < 0 || selectedRunIndex >= visibleReplayRuns.length - 1} aria-label="Next run">▶</button>
          </div>
          <div className="replay-current-run"><strong>{selectedReplay?.maze_seed ?? "No run selected"}</strong><span>{currentThought ? `Turn ${currentThought.turn}` : "Waiting to begin"}</span></div>
          <div className="replay-player-options">
            <label><span>SPEED</span><select value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value) as PlaybackSpeed)}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option></select></label>
            <button type="button" aria-pressed={showFullMap} onClick={() => setShowFullMap((value) => !value)}>{showFullMap ? "Walker light" : "Full map"}</button>
            <button type="button" onClick={() => void exportSelectedReplay()} disabled={!isReplayMode}>Export</button>
          </div>
        </footer>
      </section>

    </main>
  );
}
