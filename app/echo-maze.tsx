"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
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
import {
  BENCHMARK_SHORT_NAME,
  BENCHMARK_THEME,
  formatBenchmarkFixtureId,
} from "../lib/benchmark-brand.js";
import { DEMO_REPLAY_DETAIL, DEMO_REPLAY_PROVENANCE, type DemoReplayDetail } from "./demo-replay";
import { HeroMaze } from "./hero-maze";
import { MazeSightLayer } from "./maze-sight";
import { MazeStructure } from "./maze-structure";
import { SiteHeader } from "./site-header";
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
  suite_seed?: string;
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
const PLAYBACK_SPEEDS: PlaybackSpeed[] = [0.5, 1, 2, 4, 8];
type ReplayCueIndex = 0 | 1 | 2 | 3;
type ReplayMobilePanel = "library" | "maze" | "output";
type ReplayLyricCue = {
  turn: number;
  label: string;
  content: string;
  kind: "copy" | "estimate" | "action";
  result: MoveResult | null;
};
type ReplayLyricCueState = "is-active" | "is-past" | "is-future";

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
const REPLAY_FRAME_HOLD_MS = 1_100;
const REPLAY_MOVE_DURATION_MS = 650;
const REPLAY_CUE_RENDER_RADIUS = 12;
const REPLAY_MAX_OBSERVED_CUES = 64;
const EMPTY_CUE_INDEXES = new Set<number>();
const EMPTY_CUE_HEIGHTS = new Map<number, number>();

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

function replayModelIdentity(model: string) {
  const separator = model.indexOf("/");
  const provider = separator > 0 ? model.slice(0, separator) : "direct";
  const modelName = separator > 0 ? model.slice(separator + 1) : model;
  const providerLabel = (provider === "direct" && modelName.startsWith("gpt-")) ? "OpenAI" : ({
    openai: "OpenAI",
    deepseek: "DeepSeek",
    "x-ai": "xAI",
  }[provider] ?? provider.replaceAll("-", " "));
  const displayName = modelName
    .split("-")
    .map((part) => {
      if (part.toLowerCase() === "gpt") return "GPT";
      if (part.toLowerCase() === "deepseek") return "DeepSeek";
      if (part.toLowerCase() === "grok") return "Grok";
      if (/^v\d/i.test(part)) return `V${part.slice(1)}`;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
  return { displayName, providerLabel };
}

function replaySuiteSeed(run: ReplayRunSummary) {
  if (run.suite_seed) return run.suite_seed;
  const batchSeparator = run.batch_id?.indexOf("--") ?? -1;
  if (run.batch_id && batchSeparator > 0) return run.batch_id.slice(0, batchSeparator);
  return run.is_demo ? "bundled-demo" : "unspecified-suite";
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
const NAVIGATION_DOCK_STORAGE_KEY = "echo-maze-navigation-dock-v1";
type NavigationDock = { edge: "top" | "right" | "bottom" | "left"; ratio: number };
type NavigationPosition = { x: number; y: number; popoverX?: number };

function navigationPosition(dock: NavigationDock, viewportWidth: number, viewportHeight: number, size: number) {
  const margin = viewportWidth <= 680 ? 12 : 16;
  const minX = margin;
  const minY = margin;
  const maxX = Math.max(minX, viewportWidth - size - margin);
  const maxY = Math.max(minY, viewportHeight - size - margin);
  const ratio = Math.max(0, Math.min(1, dock.ratio));
  if (dock.edge === "top" || dock.edge === "bottom") {
    const x = minX + (maxX - minX) * ratio;
    const popoverWidth = Math.min(320, viewportWidth - 28);
    const centeredOffset = size / 2 - popoverWidth / 2;
    const minimumOffset = 14 - x;
    const maximumOffset = viewportWidth - 14 - popoverWidth - x;
    return {
      x,
      y: dock.edge === "top" ? minY : maxY,
      popoverX: Math.max(minimumOffset, Math.min(maximumOffset, centeredOffset)),
    };
  }
  if (dock.edge === "right") return { x: maxX, y: minY + (maxY - minY) * ratio };
  return { x: minX, y: minY + (maxY - minY) * ratio };
}

function nearestNavigationDock(position: NavigationPosition, viewportWidth: number, viewportHeight: number, size: number): NavigationDock {
  const margin = viewportWidth <= 680 ? 12 : 16;
  const minX = margin;
  const minY = margin;
  const maxX = Math.max(minX, viewportWidth - size - margin);
  const maxY = Math.max(minY, viewportHeight - size - margin);
  const x = Math.max(minX, Math.min(maxX, position.x));
  const y = Math.max(minY, Math.min(maxY, position.y));
  const distances = [
    ["top", y - minY],
    ["right", maxX - x],
    ["bottom", maxY - y],
    ["left", x - minX],
  ] as const;
  const edge = distances.reduce((closest, candidate) => candidate[1] < closest[1] ? candidate : closest)[0];
  const horizontalRatio = (x - minX) / Math.max(1, maxX - minX);
  const verticalRatio = (y - minY) / Math.max(1, maxY - minY);
  return { edge, ratio: edge === "top" || edge === "bottom" ? horizontalRatio : verticalRatio };
}

function AppNavigation({ currentPath }: { currentPath: "/" | "/replay" }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isBrandVisible, setIsBrandVisible] = useState(currentPath === "/" || currentPath === "/replay");
  const [dock, setDock] = useState<NavigationDock | null>(null);
  const [position, setPosition] = useState<NavigationPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const navigationRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; x: number; y: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const placeNavigation = useCallback((nextDock: NavigationDock) => {
    const size = toggleRef.current?.getBoundingClientRect().width ?? (window.innerWidth <= 680 ? 44 : 48);
    setPosition(navigationPosition(nextDock, window.innerWidth, window.innerHeight, size));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const storedDock = JSON.parse(window.localStorage.getItem(NAVIGATION_DOCK_STORAGE_KEY) ?? "null") as NavigationDock | null;
        if (!storedDock || !["top", "right", "bottom", "left"].includes(storedDock.edge) || !Number.isFinite(storedDock.ratio)) return;
        setDock(storedDock);
        placeNavigation(storedDock);
      } catch {
        // Ignore invalid or unavailable local storage and keep the default placement.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [placeNavigation]);

  useEffect(() => {
    if (!dock) return undefined;
    const handleResize = () => placeNavigation(dock);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [dock, placeNavigation]);

  useEffect(() => {
    if (currentPath !== "/") return undefined;

    const brand = document.querySelector(".hero-brand-lockup, .public-topbar .brand-lockup");
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

  const handleNavigationDragStart = useCallback((event: ReactPointerEvent<HTMLButtonElement> | ReactMouseEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const bounds = navigationRef.current?.getBoundingClientRect();
    if (!bounds) return;
    dragRef.current = {
      pointerId: "pointerId" in event ? event.pointerId : -1,
      startX: event.clientX,
      startY: event.clientY,
      originX: bounds.left,
      originY: bounds.top,
      x: bounds.left,
      y: bounds.top,
      moved: false,
    };
  }, []);

  const handleNavigationPointerMove = useCallback((event: { pointerId?: number; clientX: number; clientY: number }) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== (event.pointerId ?? -1)) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(deltaX, deltaY) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      setIsDragging(true);
      setIsOpen(false);
    }
    const size = toggleRef.current?.getBoundingClientRect().width ?? 48;
    const margin = window.innerWidth <= 680 ? 12 : 16;
    drag.x = Math.max(margin, Math.min(window.innerWidth - size - margin, drag.originX + deltaX));
    drag.y = Math.max(margin, Math.min(window.innerHeight - size - margin, drag.originY + deltaY));
    setPosition({ x: drag.x, y: drag.y });
  }, []);

  const finishNavigationDrag = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    const size = toggleRef.current?.getBoundingClientRect().width ?? 48;
    const nextDock = nearestNavigationDock({ x: drag.x, y: drag.y }, window.innerWidth, window.innerHeight, size);
    setDock(nextDock);
    placeNavigation(nextDock);
    setIsDragging(false);
    suppressClickRef.current = true;
    try {
      window.localStorage.setItem(NAVIGATION_DOCK_STORAGE_KEY, JSON.stringify(nextDock));
    } catch {
      // The button still docks for this session when storage is unavailable.
    }
    window.setTimeout(() => { suppressClickRef.current = false; }, 0);
  }, [placeNavigation]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => handleNavigationPointerMove(event);
    const handlePointerEnd = (event: PointerEvent) => finishNavigationDrag(event.pointerId);
    const handleMouseMove = (event: MouseEvent) => handleNavigationPointerMove(event);
    const handleMouseEnd = () => finishNavigationDrag(-1);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseEnd);
    };
  }, [finishNavigationDrag, handleNavigationPointerMove]);

  const linkTabIndex = isOpen ? 0 : -1;
  const popoverHorizontal = dock?.edge === "right" || ((dock?.edge === "top" || dock?.edge === "bottom") && dock.ratio > .5) ? "right" : "left";
  const popoverVertical = dock?.edge === "bottom" || ((dock?.edge === "left" || dock?.edge === "right") && dock.ratio > .5) ? "up" : "down";
  return (
    <div
      className={`app-navigation ${isOpen ? "is-open" : ""} ${isBrandVisible ? "" : "is-brand-offscreen"} ${position ? "is-user-positioned" : ""} ${isDragging ? "is-dragging" : ""}`}
      data-dock-edge={dock?.edge}
      data-popover-horizontal={popoverHorizontal}
      data-popover-vertical={popoverVertical}
      ref={navigationRef}
      style={position ? {
        left: position.x,
        top: position.y,
        "--nav-popover-x": `${position.popoverX ?? 0}px`,
      } as CSSProperties : undefined}
    >
      <button
        ref={toggleRef}
        className="nav-menu-toggle"
        type="button"
        aria-expanded={isOpen}
        aria-controls="echo-navigation"
        aria-label={isOpen ? "Close navigation" : "Open navigation"}
        title="Drag to reposition · Click to open menu"
        onClick={() => {
          if (suppressClickRef.current) return;
          setIsOpen((value) => !value);
        }}
        onPointerDown={handleNavigationDragStart}
        onMouseDown={handleNavigationDragStart}
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
          <a className={`app-nav-link ${currentPath === "/benchmark" ? "is-current" : ""}`} href="/benchmark" aria-current={currentPath === "/benchmark" ? "page" : undefined} tabIndex={linkTabIndex} onClick={() => closeNavigation()}>
            <span>Benchmark results</span><span aria-hidden="true">↗</span>
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

const HERO_MESSAGES = [
  {
    headline: "Maze exploration without a map.",
    supporting: "The EMZ Benchmark for memory-driven AI agents.",
  },
  {
    headline: "Find a way through the unseen.",
    supporting: "One corridor, one decision, one memory at a time.",
  },
] as const;

type HeroTypingPhase = "holding" | "deleting" | "typing";

function useHeroTypewriter(active: boolean) {
  const [reducedMotion, setReducedMotion] = useState(false);
  const [typingState, setTypingState] = useState(() => ({
    messageIndex: 0,
    visibleCharacters: HERO_MESSAGES[0].supporting.length,
    phase: "holding" as HeroTypingPhase,
  }));

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(query.matches);
    updatePreference();
    query.addEventListener("change", updatePreference);
    return () => query.removeEventListener("change", updatePreference);
  }, []);

  useEffect(() => {
    if (!active || reducedMotion) return;
    let delay = 48;

    if (typingState.phase === "holding") {
      delay = 2800;
    } else if (typingState.phase === "deleting") {
      delay = 24;
    }

    const timer = window.setTimeout(() => {
      setTypingState((current) => {
        if (current.phase === "holding") return { ...current, phase: "deleting" };
        if (current.phase === "deleting") {
          if (current.visibleCharacters > 0) {
            return { ...current, visibleCharacters: current.visibleCharacters - 1 };
          }
          return {
            messageIndex: (current.messageIndex + 1) % HERO_MESSAGES.length,
            visibleCharacters: 0,
            phase: "typing",
          };
        }

        const currentMessage = HERO_MESSAGES[current.messageIndex];
        if (current.visibleCharacters < currentMessage.supporting.length) {
          return { ...current, visibleCharacters: current.visibleCharacters + 1 };
        }
        return { ...current, phase: "holding" };
      });
    }, delay);

    return () => window.clearTimeout(timer);
  }, [active, reducedMotion, typingState]);

  const message = HERO_MESSAGES[typingState.messageIndex];
  const visibleCharacters = active && !reducedMotion
    ? typingState.visibleCharacters
    : message.supporting.length;
  return {
    headline: message.headline,
    supporting: message.supporting,
    visibleSupporting: message.supporting.slice(0, visibleCharacters),
    headlineIsFadingOut: active && !reducedMotion && typingState.phase === "deleting",
    showCursor: active && !reducedMotion,
  };
}

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
  const heroCopy = useHeroTypewriter(!isLab);
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
        {isLab ? (
          <h1>Can one agent remember <em>the maze it cannot see?</em></h1>
        ) : (
          <h1 className={`hero-typewriter-title${heroCopy.headlineIsFadingOut ? " is-fading-out" : ""}`}>
            {heroCopy.headline}
          </h1>
        )}
        {showReplayLink ? <a className="hero-replay-link" href="/replay">Open replay workspace <span aria-hidden="true">↗</span></a> : null}
      </div>
      <div className="intro-panel intro-panel-blue">
        <HeroMaze mazes={HERO_MAZES} />
        <div className="intro-note">
          {isLab ? (
            <p>No map. No route tool. No notebook.<br />Only observations, decisions, and outcomes from this run.</p>
          ) : (
            <p className="hero-typewriter-supporting" aria-label={heroCopy.supporting}>
              {heroCopy.visibleSupporting}
              {heroCopy.showCursor ? <span className="hero-typewriter-caret" aria-hidden="true" /> : null}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function WalkerView({ game, hidden, moveDurationMs, motionKey }: { game: GameState; hidden: boolean; moveDurationMs: number; motionKey: string }) {
  const exitVisible = observeWalkerCell(game.maze.cells, game.maze.exit, game.position).exitVisible;
  return (
    <>
      <div className={`map-layer walker-light-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
        {!hidden ? <MazeSightLayer key={`${game.maze.seed}-${motionKey}`} maze={game.maze} position={game.position} transitionMs={moveDurationMs} /> : null}
      </div>
      <div className={`map-layer walker-structure-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
        <MazeStructure maze={game.maze} ariaLabel="Maze in Walker View" className="walker-light-grid" showExit={exitVisible}>
          <GridWalkerMarker key={`${game.maze.seed}-${motionKey}`} position={game.position} size={game.maze.cells.length} transitionMs={moveDurationMs} />
        </MazeStructure>
      </div>
    </>
  );
}

function SpectatorMap({ game, hidden, moveDurationMs, motionKey }: { game: GameState; hidden: boolean; moveDurationMs: number; motionKey: string }) {
  return (
    <div className={`map-layer spectator-map-layer ${hidden ? "is-hidden" : "is-visible"}`} aria-hidden={hidden}>
      {!hidden ? <MazeSightLayer key={`${game.maze.seed}-${motionKey}-full`} maze={game.maze} position={game.position} transitionMs={moveDurationMs} /> : null}
      <MazeStructure maze={game.maze} ariaLabel="Maze in Spectator View" className="spectator-maze-grid" showStart showExit>
        <GridWalkerMarker key={`${game.maze.seed}-${motionKey}`} position={game.position} size={game.maze.cells.length} transitionMs={moveDurationMs} />
      </MazeStructure>
    </div>
  );
}

const MazeViewport = memo(function MazeViewport({
  game,
  showFullMap,
  showCaption = true,
  moveDurationMs = 1_100,
  motionKey = "continuous",
}: {
  game: GameState;
  showFullMap: boolean;
  showCaption?: boolean;
  moveDurationMs?: number;
  motionKey?: string;
}) {
  return (
    <div className="map-viewport">
      <div className="map-stage-shell">
        <div className="map-stage maze-grid-stage">
          <WalkerView game={game} hidden={showFullMap} moveDurationMs={moveDurationMs} motionKey={motionKey} />
          <SpectatorMap game={game} hidden={!showFullMap} moveDurationMs={moveDurationMs} motionKey={motionKey} />
        </div>
      </div>
      <div className="map-legend-slot" aria-hidden="true">
        <div className={`map-legend mode-legend ${showFullMap ? "is-hidden" : "is-visible"}`}>
          <span><i className="legend-swatch swatch-light" />Visible to Walker</span>
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
            ? "Spectator View reveals the complete map and actual position, which are never shown to Walker."
            : "Walker View shows only what the agent can see through wall-blocked sightlines."}
        </p>
      ) : null}
    </div>
  );
});

const ReplayLyricCueItem = memo(function ReplayLyricCueItem({
  cue,
  cueIndex,
  cueState,
  result,
  renderContent,
  reservedHeight,
  onSelect,
}: {
  cue: ReplayLyricCue;
  cueIndex: number;
  cueState: ReplayLyricCueState;
  result: MoveResult | null;
  renderContent: boolean;
  reservedHeight?: number;
  onSelect: (turn: number, cueIndex: ReplayCueIndex) => void;
}) {
  return (
    <section
      className={`replay-lyric-cue ${cueState} is-${cue.kind}${renderContent ? "" : " is-virtual-placeholder"}`}
      data-replay-cue={cueIndex}
      style={!renderContent && reservedHeight ? { height: reservedHeight } : undefined}
    >
      {renderContent ? (
        <button
          className="replay-lyric-cue-button"
          type="button"
          aria-label={`Go to turn ${cue.turn}, ${cue.label.toLowerCase()}`}
          aria-current={cueState === "is-active" ? "step" : undefined}
          onClick={() => onSelect(cue.turn, cueIndex % 4 as ReplayCueIndex)}
        >
          <span><i>TURN {String(cue.turn).padStart(2, "0")}</i>{cue.label}</span>
          {cue.kind === "copy" ? <p>{cue.content}</p> : <strong>{cue.content}</strong>}
          {cue.kind === "action" ? (
            <em className={result === "blocked" ? "is-blocked" : ""}>
              {result === "blocked" ? "Blocked — stayed in place" : result === "moved" ? "Move succeeded" : "Awaiting move"}
            </em>
          ) : null}
        </button>
      ) : null}
    </section>
  );
});

function ReplaySpeedPicker({ value, onChange }: { value: PlaybackSpeed; onChange: (speed: PlaybackSpeed) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      pickerRef.current?.querySelector<HTMLButtonElement>(".replay-speed-trigger")?.focus();
    };
    window.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div className={`replay-speed-picker ${isOpen ? "is-open" : ""}`} ref={pickerRef}>
      <button
        className="replay-speed-trigger"
        type="button"
        aria-label={`Playback speed ${value} times`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-keyshortcuts="Shift+Comma Shift+Period"
        title="Slower · Shift + <  /  Faster · Shift + >"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span>SPEED&nbsp;&nbsp;{value}×</span>
      </button>
      {isOpen ? (
        <div className="replay-speed-menu" role="listbox" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((speed) => (
            <button
              type="button"
              role="option"
              aria-selected={value === speed}
              className={value === speed ? "is-selected" : ""}
              key={speed}
              onClick={() => {
                onChange(speed);
                setIsOpen(false);
              }}
            >
              <span>{speed}×</span>
              {value === speed ? <i aria-hidden="true">●</i> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReplaySuitePicker({
  suites,
  value,
  onChange,
  onOpenChange,
}: {
  suites: Array<{ seed: string; runs: ReplayRunSummary[] }>;
  value: string;
  onChange: (suiteSeed: string) => void;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) {
        setIsOpen(false);
        onOpenChange(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      onOpenChange(false);
      pickerRef.current?.querySelector<HTMLButtonElement>(".replay-suite-trigger")?.focus();
    };
    window.addEventListener("pointerdown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen, onOpenChange]);

  return (
    <div className={`replay-suite-picker ${isOpen ? "is-open" : ""}`} ref={pickerRef}>
      <button
        className="replay-suite-trigger"
        type="button"
        aria-label={`Runs from suite ${value}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => {
          const nextOpen = !isOpen;
          setIsOpen(nextOpen);
          onOpenChange(nextOpen);
        }}
      >
        <span>RUNS</span>
        <svg aria-hidden="true" viewBox="0 0 12 12">
          <path d="m2.5 4.25 3.5 3.5 3.5-3.5" />
        </svg>
      </button>
      {isOpen ? (
        <div className="replay-suite-menu" role="listbox" aria-label="Benchmark suite seed">
          {suites.map((suite) => (
            <button
              type="button"
              role="option"
              aria-selected={value === suite.seed}
              className={value === suite.seed ? "is-selected" : ""}
              key={suite.seed}
              onClick={() => {
                onChange(suite.seed);
                setIsOpen(false);
                onOpenChange(false);
              }}
            >
              <span><strong>{suite.seed}</strong><small>{suite.runs.length} runs</small></span>
              {value === suite.seed ? <i aria-hidden="true">●</i> : null}
            </button>
          ))}
        </div>
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
            {showFullMap ? "Walker View" : "Spectator View"}
          </button>
          <span className={`visibility-tag ${showFullMap ? "spectator-tag" : "local-tag"}`}>{showFullMap ? "SPECTATOR" : "LINE OF SIGHT"}</span>
        </div>
      </div>
      <div className={`walker-card-body ${showTurnOutput ? "has-turn-output" : ""}`}>
        <div className="walker-card-main">
          <div className="map-heading">
            <span>Maze {formatBenchmarkFixtureId(game.maze.seed)} · shortest path {game.maze.routeLength} moves</span>
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
          <p>Maze {formatBenchmarkFixtureId(decisionGame.maze.seed)} · shortest path {decisionGame.maze.routeLength} moves</p>
        </div>
        <div className="landing-replay-actions">
          <button className="button view-toggle" type="button" aria-pressed={showFullMap} onClick={onToggleFullMap}>
            {showFullMap ? "Walker View" : "Spectator View"}
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
          <div className="benchmark-identity">
            <PanelLabel>{BENCHMARK_SHORT_NAME.toUpperCase()}</PanelLabel>
            <span>{BENCHMARK_THEME}</span>
          </div>
          <h2 id="benchmark-heading"><span>The exit is only</span><em>half the story.</em></h2>
          <div className="benchmark-summary">
            <p>One Walker. One conversation. No map or route tool—only observations, memory, and a replay of every move.</p>
            <a className="benchmark-link" href="/benchmark">Explore benchmark results <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <ol className="benchmark-rules" aria-label="Benchmark principles">
          <li>
            <span>01 / SEE</span>
            <strong>Corridors only.</strong>
            <small>Partial observability</small>
          </li>
          <li>
            <span>02 / REMEMBER</span>
            <strong>This run only.</strong>
            <small>One conversation</small>
          </li>
          <li>
            <span>03 / PROVE</span>
            <strong>Every turn replayed.</strong>
            <small>Visible evidence</small>
          </li>
        </ol>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="landing-footer">
      <strong>ECHO MAZE</strong>
      <span>Where AI memory finds its way.</span>
      <nav aria-label="Footer navigation">
        <a href="/benchmark">Benchmark</a>
        <a href="/replay">Replay</a>
        <a href={GITHUB_REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
      </nav>
    </footer>
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
      <LandingFooter />
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
  const [mobilePanel, setMobilePanel] = useState<ReplayMobilePanel>("maze");
  const [replayRuns, setReplayRuns] = useState<ReplayRunSummary[]>([DEMO_REPLAY_SUMMARY]);
  const [selectedReplaySuite, setSelectedReplaySuite] = useState(replaySuiteSeed(DEMO_REPLAY_SUMMARY));
  const [isReplaySuiteMenuOpen, setIsReplaySuiteMenuOpen] = useState(false);
  const [selectedReplayConfiguration, setSelectedReplayConfiguration] = useState(replayConfigurationKey(DEMO_REPLAY_SUMMARY));
  const [selectedReplayId, setSelectedReplayId] = useState(DEMO_REPLAY_DETAIL.run.id);
  const [playbackFrames, setPlaybackFrames] = useState<ReplayFrame[]>(DEMO_REPLAY_FRAMES);
  const [playbackIndex, setPlaybackIndex] = useState(0);
  const [settledPlaybackIndex, setSettledPlaybackIndex] = useState(0);
  const [replayMotionRevision, setReplayMotionRevision] = useState(0);
  const [activeCueIndex, setActiveCueIndex] = useState<ReplayCueIndex>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1);
  const [isReplayPlaying, setIsReplayPlaying] = useState(false);
  const [isReplayLoading, setIsReplayLoading] = useState(false);
  const [replayLibraryError, setReplayLibraryError] = useState<string | null>(null);
  const initialReplayLoadedRef = useRef(false);
  const lyricViewportRef = useRef<HTMLDivElement>(null);
  const lyricTrackRef = useRef<HTMLDivElement>(null);
  const [cueVirtualization, setCueVirtualization] = useState<{
    replayId: string;
    visibleCueIndexes: Set<number>;
    cueHeights: Map<number, number>;
  }>(() => ({ replayId: selectedReplayId, visibleCueIndexes: new Set(), cueHeights: new Map() }));
  const reduceMotion = useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot, () => false);

  const seekPlaybackFrame = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(index, playbackFrames.length - 1));
    const nextFrame = playbackFrames[nextIndex];
    setPlaybackIndex(nextIndex);
    setSettledPlaybackIndex(nextIndex);
    setReplayMotionRevision((revision) => revision + 1);
    setActiveCueIndex(nextFrame?.game.phase === "walker_move" ? 0 : 3);
  }, [playbackFrames]);

  const seekReplayCue = useCallback((turn: number, cueIndex: ReplayCueIndex) => {
    const decisionFrameIndex = playbackFrames.findIndex((frame) => {
      const thought = frame.game.history.at(-1);
      return frame.game.phase === "walker_move" && thought?.turn === turn;
    });
    if (decisionFrameIndex < 0) return;
    seekPlaybackFrame(decisionFrameIndex);
    setActiveCueIndex(cueIndex);
  }, [playbackFrames, seekPlaybackFrame]);

  const loadReplay = useCallback(async (runId: string) => {
    setSelectedReplayId(runId);
    setIsReplayPlaying(false);
    setPlaybackIndex(0);
    setSettledPlaybackIndex(0);
    setReplayMotionRevision((revision) => revision + 1);
    setActiveCueIndex(0);
    if (!runId) {
      setPlaybackFrames([]);
      return;
    }
    setIsReplayLoading(true);
    setPlaybackFrames([]);
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
        const requestedRunId = new URLSearchParams(window.location.search).get("run");
        const initialRun = publishedRuns.find((run) => run.id === requestedRunId) ?? publishedRuns[0];
        setSelectedReplaySuite(replaySuiteSeed(initialRun));
        setSelectedReplayConfiguration(replayConfigurationKey(initialRun));
        await loadReplay(initialRun.id);
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
      REPLAY_FRAME_HOLD_MS / playbackSpeed,
    );
    return () => window.clearTimeout(timer);
  }, [activeCueIndex, isReplayPlaying, playbackFrames, playbackIndex, playbackSpeed]);

  const playbackFrame = playbackFrames[playbackIndex] ?? null;
  const settledPlaybackFrame = playbackFrames[settledPlaybackIndex] ?? playbackFrame;
  const isReplayMode = Boolean(selectedReplayId && playbackFrame);
  const selectedReplay = replayRuns.find((run) => run.id === selectedReplayId) ?? null;
  const visibleReplayRuns = useMemo(
    () => replayRuns.filter((run) => run.is_demo || (run.max_turn ?? 0) > 0),
    [replayRuns],
  );
  const replaySuites = useMemo(() => {
    const suites = new Map<string, ReplayRunSummary[]>();
    for (const run of visibleReplayRuns) {
      const suiteSeed = replaySuiteSeed(run);
      const suiteRuns = suites.get(suiteSeed) ?? [];
      suiteRuns.push(run);
      suites.set(suiteSeed, suiteRuns);
    }
    return [...suites.entries()].map(([seed, runs]) => ({ seed, runs }));
  }, [visibleReplayRuns]);
  const selectedSuiteGroup = replaySuites.find((suite) => suite.seed === selectedReplaySuite)
    ?? replaySuites[0]
    ?? null;
  const replayGroups = useMemo(() => {
    const configurations = new Map<string, {
      model: string;
      reasoningEffort: string | null;
      batches: Map<string, ReplayRunSummary[]>;
    }>();
    for (const run of selectedSuiteGroup?.runs ?? []) {
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
  }, [selectedSuiteGroup]);
  const selectedModelGroup = replayGroups.find((group) => group.key === selectedReplayConfiguration)
    ?? replayGroups[0]
    ?? null;
  const currentThought = settledPlaybackFrame?.game.history.at(-1) ?? null;
  const moveCount = settledPlaybackFrame
    ? Math.max(0, settledPlaybackFrame.game.turn - settledPlaybackFrame.game.collisions)
    : 0;
  const replayThoughts = useMemo(() => {
    const turns = new Map<number, WalkerTurn>();
    for (const frame of playbackFrames) {
      for (const thought of frame.game.history) turns.set(thought.turn, thought);
    }
    return [...turns.values()].sort((a, b) => a.turn - b.turn);
  }, [playbackFrames]);
  const lyricCues = useMemo<ReplayLyricCue[]>(() => replayThoughts.flatMap((thought) => {
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
  const suiteReplayRuns = useMemo(() => selectedSuiteGroup?.runs ?? [], [selectedSuiteGroup]);
  const selectedRunIndex = suiteReplayRuns.findIndex((run) => run.id === selectedReplayId);
  const playbackProgress = playbackFrames.length > 1 ? playbackIndex / (playbackFrames.length - 1) * 100 : 0;
  const visibleCueIndexes = cueVirtualization.replayId === selectedReplayId
    ? cueVirtualization.visibleCueIndexes
    : EMPTY_CUE_INDEXES;
  const cueHeights = cueVirtualization.replayId === selectedReplayId
    ? cueVirtualization.cueHeights
    : EMPTY_CUE_HEIGHTS;

  useEffect(() => {
    const viewport = lyricViewportRef.current;
    const track = lyricTrackRef.current;
    if (!viewport || !track || typeof IntersectionObserver === "undefined") return undefined;

    const cueElements = [...track.querySelectorAll<HTMLElement>("[data-replay-cue]")];
    const intersectionObserver = new IntersectionObserver((entries) => {
      const enteredCueIndexes = entries.flatMap((entry) => {
        const cueIndex = Number((entry.target as HTMLElement).dataset.replayCue);
        return entry.isIntersecting && Number.isInteger(cueIndex) ? [cueIndex] : [];
      });
      if (enteredCueIndexes.length === 0) return;
      const anchorCueIndex = enteredCueIndexes.reduce((sum, cueIndex) => sum + cueIndex, 0) / enteredCueIndexes.length;
      setCueVirtualization((current) => {
        const base = current.replayId === selectedReplayId
          ? current
          : { replayId: selectedReplayId, visibleCueIndexes: new Set<number>(), cueHeights: new Map<number, number>() };
        const next = new Set(base.visibleCueIndexes);
        for (const cueIndex of enteredCueIndexes) next.add(cueIndex);
        if (next.size > REPLAY_MAX_OBSERVED_CUES) {
          const closestCueIndexes = [...next]
            .sort((left, right) => Math.abs(left - anchorCueIndex) - Math.abs(right - anchorCueIndex))
            .slice(0, REPLAY_MAX_OBSERVED_CUES);
          next.clear();
          closestCueIndexes.forEach((cueIndex) => next.add(cueIndex));
        }
        const changed = next.size !== base.visibleCueIndexes.size
          || [...next].some((cueIndex) => !base.visibleCueIndexes.has(cueIndex));
        if (!changed) return base === current ? current : base;
        return { ...base, visibleCueIndexes: next };
      });
    }, { root: viewport, rootMargin: "150% 0px" });
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          const measuredHeights = new Map<number, number>();
          for (const entry of entries) {
            const cue = entry.target as HTMLElement;
            if (!cue.firstElementChild) continue;
            const cueIndex = Number(cue.dataset.replayCue);
            const measuredHeight = entry.borderBoxSize[0]?.blockSize ?? cue.offsetHeight;
            if (Number.isInteger(cueIndex)) measuredHeights.set(cueIndex, measuredHeight);
          }
          if (measuredHeights.size === 0) return;
          setCueVirtualization((current) => {
            const base = current.replayId === selectedReplayId
              ? current
              : { replayId: selectedReplayId, visibleCueIndexes: new Set<number>(), cueHeights: new Map<number, number>() };
            const nextHeights = new Map(base.cueHeights);
            let changed = false;
            for (const [cueIndex, measuredHeight] of measuredHeights) {
              if (nextHeights.get(cueIndex) === measuredHeight) continue;
              nextHeights.set(cueIndex, measuredHeight);
              changed = true;
            }
            if (!changed) return base === current ? current : base;
            return { ...base, cueHeights: nextHeights };
          });
        });

    cueElements.forEach((cue) => {
      intersectionObserver.observe(cue);
      resizeObserver?.observe(cue);
    });
    return () => {
      intersectionObserver.disconnect();
      resizeObserver?.disconnect();
    };
  }, [lyricCues.length, selectedReplayId]);

  useEffect(() => {
    if (!playbackFrame || settledPlaybackIndex === playbackIndex) return;
    const settledFrame = playbackFrames[settledPlaybackIndex];
    if (!settledFrame) {
      const timer = window.setTimeout(() => setSettledPlaybackIndex(playbackIndex), 0);
      return () => window.clearTimeout(timer);
    }
    const sameMaze = settledFrame.game.maze.seed === playbackFrame.game.maze.seed;
    const moveDistance = Math.abs(settledFrame.game.position.c - playbackFrame.game.position.c)
      + Math.abs(settledFrame.game.position.r - playbackFrame.game.position.r);
    if (!sameMaze || moveDistance !== 1) {
      const timer = window.setTimeout(() => setSettledPlaybackIndex(playbackIndex), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(
      () => setSettledPlaybackIndex(playbackIndex),
      REPLAY_MOVE_DURATION_MS / playbackSpeed,
    );
    return () => window.clearTimeout(timer);
  }, [playbackFrame, playbackFrames, playbackIndex, playbackSpeed, settledPlaybackIndex]);

  useEffect(() => {
    const viewport = lyricViewportRef.current;
    const cue = viewport?.querySelector<HTMLElement>(`[data-replay-cue="${activeLyricCueIndex}"]`);
    if (!viewport || !cue) return;
    const targetTop = cue.offsetTop - viewport.clientHeight * .42 + cue.clientHeight / 2;
    const rapidlyAdvancing = isReplayPlaying && playbackSpeed >= 4;
    viewport.scrollTo({ top: Math.max(0, targetTop), behavior: reduceMotion || rapidlyAdvancing ? "auto" : "smooth" });
  }, [activeLyricCueIndex, isReplayPlaying, lyricCues.length, playbackSpeed, reduceMotion, selectedReplayId]);

  const toggleReplayPlayback = useCallback(() => {
    if (!isReplayPlaying && playbackIndex >= playbackFrames.length - 1) {
      setPlaybackIndex(0);
      setSettledPlaybackIndex(0);
      setReplayMotionRevision((revision) => revision + 1);
      setActiveCueIndex(0);
    }
    setIsReplayPlaying((value) => !value);
  }, [isReplayPlaying, playbackFrames.length, playbackIndex]);

  const selectAdjacentRun = useCallback((offset: -1 | 1) => {
    const adjacentRun = suiteReplayRuns[selectedRunIndex + offset];
    if (adjacentRun) {
      setSelectedReplayConfiguration(replayConfigurationKey(adjacentRun));
      void loadReplay(adjacentRun.id);
    }
  }, [loadReplay, selectedRunIndex, suiteReplayRuns]);

  const selectReplaySuite = useCallback((suiteSeed: string) => {
    setSelectedReplaySuite(suiteSeed);
    const firstRun = replaySuites.find((suite) => suite.seed === suiteSeed)?.runs[0];
    if (!firstRun) return;
    setSelectedReplayConfiguration(replayConfigurationKey(firstRun));
    void loadReplay(firstRun.id);
  }, [loadReplay, replaySuites]);

  useEffect(() => {
    const handleReplayShortcut = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, button, a, summary, [contenteditable='true']")) return;

      if (event.code === "Space") {
        if (!isReplayMode || playbackFrames.length < 2 || event.repeat) return;
        event.preventDefault();
        toggleReplayPlayback();
        return;
      }
      if (event.shiftKey && (event.key === "<" || event.key === ">")) {
        event.preventDefault();
        const currentSpeedIndex = PLAYBACK_SPEEDS.indexOf(playbackSpeed);
        const direction = event.key === "<" ? -1 : 1;
        const nextSpeedIndex = Math.max(0, Math.min(PLAYBACK_SPEEDS.length - 1, currentSpeedIndex + direction));
        setPlaybackSpeed(PLAYBACK_SPEEDS[nextSpeedIndex]);
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const offset = event.key === "ArrowLeft" ? -1 : 1;
      if (event.shiftKey) {
        if (!event.repeat) selectAdjacentRun(offset);
        return;
      }
      if (!isReplayMode || playbackFrames.length < 2) return;
      seekPlaybackFrame(playbackIndex + offset);
    };
    window.addEventListener("keydown", handleReplayShortcut);
    return () => window.removeEventListener("keydown", handleReplayShortcut);
  }, [isReplayMode, playbackFrames.length, playbackIndex, playbackSpeed, seekPlaybackFrame, selectAdjacentRun, toggleReplayPlayback]);

  return (
    <main className="echo-app replay-page replay-player-page">
      <SiteHeader active="replays" />
      <AppNavigation currentPath="/replay" />
      <section
        className={`replay-player${mobilePanel === "library" ? " is-library-view" : ""}`}
        aria-label="Replay player"
      >
        <aside
          className={`replay-player-library ${mobilePanel === "library" ? "is-mobile-active" : ""}`}
          id="replay-library-panel"
          role="tabpanel"
        >
          <div className="replay-player-library-head">
            <PanelLabel>REPLAY LIBRARY</PanelLabel>
            <strong>{visibleReplayRuns.length} recorded runs</strong>
          </div>
          <div className="replay-run-list">
            <nav className="replay-model-list" aria-label="Models">
              <span className="replay-library-column-label">MODELS</span>
              {replayGroups.map((modelGroup) => {
                const identity = replayModelIdentity(modelGroup.model);
                return (
                  <button
                    className={modelGroup.key === selectedModelGroup?.key ? "is-selected" : ""}
                    type="button"
                    key={modelGroup.key}
                    onClick={() => setSelectedReplayConfiguration(modelGroup.key)}
                    aria-pressed={modelGroup.key === selectedModelGroup?.key}
                    title={`${modelGroup.model} · reasoning ${modelGroup.reasoningEffort ?? "not specified"}`}
                  >
                    <strong>{identity.displayName}</strong>
                    <small><span>{identity.providerLabel}</span><i>·</i><span>{modelGroup.reasoningEffort ? `${modelGroup.reasoningEffort.toUpperCase()} EFFORT` : "EFFORT N/A"}</span></small>
                  </button>
                );
              })}
            </nav>
            <div className={`replay-model-runs ${isReplaySuiteMenuOpen ? "is-suite-menu-open" : ""}`}>
              <div className="replay-library-column-label replay-suite-column-label">
                <ReplaySuitePicker
                  suites={replaySuites}
                  value={selectedSuiteGroup?.seed ?? ""}
                  onChange={selectReplaySuite}
                  onOpenChange={setIsReplaySuiteMenuOpen}
                />
              </div>
              {selectedModelGroup?.batches.map((batch) => (
                  <div className="replay-batch-group" key={batch.batchId}>
                    {batch.runs.map((run) => {
                      const mazeLabel = formatBenchmarkFixtureId(run.maze_seed).replace(/^EMZ-V0-/, "").replace(/-(\d+)$/, " $1").replaceAll("-", " ").toLowerCase();
                      return (
                        <button
                          className={`replay-run-item is-status-${run.status.replaceAll("_", "-")} ${run.id === selectedReplayId ? "is-selected" : ""}`}
                          type="button"
                          key={run.id}
                          onClick={() => {
                            setSelectedReplayConfiguration(replayConfigurationKey(run));
                            setMobilePanel("maze");
                            void loadReplay(run.id);
                          }}
                          disabled={isReplayLoading || isReplaySuiteMenuOpen}
                          aria-current={run.id === selectedReplayId ? "true" : undefined}
                        >
                          <span className="replay-run-copy">
                            <strong>{mazeLabel}</strong>
                            <small className={`replay-run-status is-${run.status.replaceAll("_", "-")}`}>
                              {run.status.replaceAll("_", " ")}
                            </small>
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
          <div className="replay-now-playing-title">
            <h1>{selectedReplay?.model ?? "Select a replay"}</h1>
            <strong>{selectedReplay ? formatBenchmarkFixtureId(selectedReplay.maze_seed) : "No maze selected"}</strong>
          </div>
          <div className="replay-now-playing-meta">
            <span>{selectedReplay ? `${selectedReplay.status.replaceAll("_", " ")} · shortest path ${playbackFrame?.game.maze.routeLength ?? "—"} moves` : "Choose a run from the library"}</span>
          </div>
        </header>

        <div className="replay-mobile-tabs" aria-label="Replay views" role="tablist">
          {([
            ["library", "Library"],
            ["maze", "Maze"],
            ["output", "Output"],
          ] as const).map(([panel, label]) => (
            <button
              className={mobilePanel === panel ? "is-selected" : ""}
              id={`replay-${panel}-tab`}
              type="button"
              role="tab"
              aria-controls={`replay-${panel}-panel`}
              aria-selected={mobilePanel === panel}
              key={panel}
              onClick={() => setMobilePanel(panel)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={`replay-player-main ${mobilePanel !== "library" ? "is-mobile-active" : ""}`}>
          <div className="replay-player-main-inner">
            {playbackFrame ? (
              <section
                className={`replay-player-maze ${mobilePanel === "maze" ? "is-mobile-active" : ""}`}
                id="replay-maze-panel"
                role="tabpanel"
                aria-label="Maze playback"
              >
                <MazeViewport
                  game={playbackFrame.game}
                  showFullMap={showFullMap}
                  showCaption={false}
                  moveDurationMs={REPLAY_MOVE_DURATION_MS / playbackSpeed}
                  motionKey={`${selectedReplayId}-${replayMotionRevision}`}
                />
              </section>
            ) : (
              <section
                className={`replay-player-maze replay-player-empty ${mobilePanel === "maze" ? "is-mobile-active" : ""}`}
                id="replay-maze-panel"
                role="tabpanel"
              ><span>Select a run</span></section>
            )}

            <aside
              className={`replay-player-output ${mobilePanel === "output" ? "is-mobile-active" : ""}`}
              id="replay-output-panel"
              role="tabpanel"
              aria-live="polite"
            >
          <div className="replay-output-heading">
            <PanelLabel>AGENT OUTPUT</PanelLabel>
            <span>{isReplayLoading ? "Loading…" : `Turn ${String(currentThought?.turn ?? 0).padStart(2, "0")}`}</span>
          </div>
          <div className="replay-output-metrics">
            <div><span>TURN</span><strong>{String(settledPlaybackFrame?.game.turn ?? 0).padStart(2, "0")}</strong></div>
            <div><span>MOVES</span><strong>{String(moveCount).padStart(2, "0")}</strong></div>
            <div><span>WALL HITS</span><strong>{String(settledPlaybackFrame?.game.collisions ?? 0).padStart(2, "0")}</strong></div>
          </div>
          <div className="replay-lyric-window">
            <div className="replay-lyric-viewport" ref={lyricViewportRef}>
              <div className="replay-lyric-track" ref={lyricTrackRef}>
                {lyricCues.length === 0 ? (
                  <section className="replay-lyric-cue is-active is-copy" data-replay-cue="0">
                    <span><i>01</i>ENVIRONMENT INPUT</span>
                    <p>Waiting for the first observation.</p>
                  </section>
                ) : lyricCues.map((cue, cueIndex) => (
                  <ReplayLyricCueItem
                    cue={cue}
                    cueIndex={cueIndex}
                    cueState={cueIndex === activeLyricCueIndex ? "is-active" : cueIndex < activeLyricCueIndex ? "is-past" : "is-future"}
                    result={cue.kind !== "action" || !currentThought
                      ? null
                      : cue.turn < currentThought.turn
                        ? cue.result
                        : cue.turn === currentThought.turn
                          ? currentThought.result
                          : null}
                    renderContent={visibleCueIndexes.has(cueIndex) || Math.abs(cueIndex - activeLyricCueIndex) <= REPLAY_CUE_RENDER_RADIUS}
                    reservedHeight={cueHeights.get(cueIndex)}
                    onSelect={seekReplayCue}
                    key={`${cue.turn}-${cue.label}`}
                  />
                ))}
              </div>
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
              aria-keyshortcuts="ArrowLeft ArrowRight"
              style={{ "--replay-progress": `${playbackProgress}%` } as CSSProperties}
            />
            <div><span>{playbackFrame?.note ?? "Select a run to begin"}</span><strong>{isReplayMode ? `${playbackIndex + 1} / ${playbackFrames.length}` : "0 / 0"}</strong></div>
          </div>
          <div className="replay-transport">
            <button type="button" onClick={() => selectAdjacentRun(-1)} disabled={selectedRunIndex <= 0} aria-label="Previous run" aria-keyshortcuts="Shift+ArrowLeft" title="Previous run · Shift + ←"><span className="replay-run-skip-icon" aria-hidden="true">◀◀</span></button>
            <button className="replay-transport-play" type="button" onClick={toggleReplayPlayback} disabled={!isReplayMode || playbackFrames.length < 2} aria-label={isReplayPlaying ? "Pause replay" : "Play replay"} aria-keyshortcuts="Space" title="Play or pause · Space">{isReplayPlaying ? "Ⅱ" : "▶"}</button>
            <button type="button" onClick={() => selectAdjacentRun(1)} disabled={selectedRunIndex < 0 || selectedRunIndex >= visibleReplayRuns.length - 1} aria-label="Next run" aria-keyshortcuts="Shift+ArrowRight" title="Next run · Shift + →"><span className="replay-run-skip-icon" aria-hidden="true">▶▶</span></button>
          </div>
          <div className="replay-current-run"><strong>{selectedReplay ? formatBenchmarkFixtureId(selectedReplay.maze_seed) : "No run selected"}</strong><span>{currentThought ? `Turn ${currentThought.turn}` : "Waiting to begin"}</span></div>
          <div className="replay-player-options">
            <ReplaySpeedPicker value={playbackSpeed} onChange={setPlaybackSpeed} />
            <button type="button" aria-pressed={showFullMap} onClick={() => setShowFullMap((value) => !value)}>{showFullMap ? "Walker View" : "Spectator View"}</button>
          </div>
        </footer>
      </section>

    </main>
  );
}
