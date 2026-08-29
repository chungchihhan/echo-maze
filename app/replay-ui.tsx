"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { DIRECTIONS, pointKey, samePoint, visibleWalkerPoints } from "../lib/maze/index.js";
import type { Cell, DirectionKey, Maze, MoveResult, Point } from "../lib/maze/types.js";

type RelativePoint = { x: number; y: number };
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
  estimatedPosition: RelativePoint;
  notes: string;
  action: DirectionKey;
  result: MoveResult | null;
};
type ReplayGame = {
  maze: Maze;
  position: Point;
  relativePosition: RelativePoint;
  phase: "walker_think" | "walker_move";
  turn: number;
  moves: number;
  collisions: number;
  status: "ready" | "running" | "won";
  lastAction: DirectionKey | null;
  lastResult: MoveResult | null;
  history: WalkerTurn[];
};
export type ReplayRunSummary = {
  id: string;
  created_at: number;
  updated_at: number;
  status: string;
  model: string;
  maze_seed: string;
  event_count: number;
  max_turn: number | null;
  had_error: number;
  successful_moves?: number;
  wall_hits?: number;
  spl?: number;
  batch_id?: string;
  policy_revision?: string;
};
type ReplayEvent = { sequence: number; createdAt: number; turn: number; phase: string; type: string; payload: unknown };
type ReplayDetail = {
  run: {
    id: string;
    createdAt: number;
    updatedAt: number;
    status: string;
    model: string;
    mazeSeed: string;
    maze: Maze;
    initialPosition: Point;
  };
  events: ReplayEvent[];
};
type ReplayFrame = { game: ReplayGame; sequence: number; note: string; error: string | null };
type PlaybackSpeed = 0.5 | 1 | 2 | 4 | 8;

function StreamingText({ text, animate, delay = 0, duration = 700, placeholder = "" }: {
  text: string;
  animate: boolean;
  delay?: number;
  duration?: number;
  placeholder?: string;
}) {
  const animationKey = `${delay}:${duration}:${text}`;
  const [streamState, setStreamState] = useState({ key: "", text: "", streaming: false });
  const visibleText = animate && streamState.key === animationKey ? streamState.text : animate ? "" : text;
  const streaming = animate && streamState.key === animationKey && streamState.streaming;

  useEffect(() => {
    if (!animate) return undefined;

    let interval: number | undefined;
    const timeout = window.setTimeout(() => {
      let index = 0;
      const tick = 18;
      const charactersPerTick = Math.max(1, Math.ceil(text.length / Math.max(1, duration / tick)));
      setStreamState({ key: animationKey, text: "", streaming: true });
      interval = window.setInterval(() => {
        index = Math.min(text.length, index + charactersPerTick);
        setStreamState({ key: animationKey, text: text.slice(0, index), streaming: index < text.length });
        if (index >= text.length) {
          if (interval !== undefined) window.clearInterval(interval);
        }
      }, tick);
    }, delay);

    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, [animate, animationKey, delay, duration, text]);

  return <span className={streaming ? "streaming-text is-streaming" : "streaming-text"}>{visibleText || placeholder}</span>;
}

function emptyObservation(): ObservationDTO {
  return { openDirections: [], blockedDirections: [], sightlines: [], exitVisible: false, lastAction: null, lastResult: null };
}

function objectPayload(value: unknown) {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function pointPayload(value: unknown, fallback: Point): Point {
  if (!value || typeof value !== "object") return fallback;
  const point = value as Partial<Point>;
  return Number.isInteger(point.r) && Number.isInteger(point.c)
    ? { r: point.r as number, c: point.c as number }
    : fallback;
}

export function buildReplayFrames(detail: ReplayDetail): ReplayFrame[] {
  let state: ReplayGame = {
    maze: detail.run.maze,
    position: detail.run.initialPosition,
    relativePosition: { x: 0, y: 0 },
    phase: "walker_think",
    turn: 0,
    moves: 0,
    collisions: 0,
    status: "ready",
    lastAction: null,
    lastResult: null,
    history: [],
  };
  const frames: ReplayFrame[] = [{ game: state, sequence: 0, note: "Run loaded", error: null }];
  let pendingObservation = emptyObservation();

  for (const event of detail.events) {
    const payload = objectPayload(event.payload);
    if (event.type === "agent_request" && payload.role === "solo_walker") {
      if (payload.observation && typeof payload.observation === "object") pendingObservation = payload.observation as ObservationDTO;
      continue;
    }
    if (event.type === "solo_walker_response") {
      const action = payload.action ?? payload.direction;
      if (typeof action !== "string" || !DIRECTIONS.some((item) => item.key === action)) continue;
      const estimated = objectPayload(payload.estimatedPosition ?? payload.positionEstimate ?? payload.believedPosition);
      const entry: WalkerTurn = {
        turn: typeof payload.turn === "number" ? payload.turn : state.turn + 1,
        observation: pendingObservation,
        estimatedPosition: { x: typeof estimated.x === "number" ? estimated.x : 0, y: typeof estimated.y === "number" ? estimated.y : 0 },
        notes: typeof payload.notes === "string"
          ? payload.notes
          : typeof payload.navigationNote === "string"
            ? payload.navigationNote
            : typeof payload.coordinateNote === "string" ? payload.coordinateNote : "Notes unavailable.",
        action: action as DirectionKey,
        result: null,
      };
      state = { ...state, phase: "walker_move", status: "running", history: [...state.history, entry] };
      frames.push({ game: state, sequence: event.sequence, note: `Turn ${entry.turn}: decision`, error: null });
      continue;
    }
    if (event.type === "solo_walker_move" || event.type === "environment_move") {
      const direction = typeof payload.direction === "string" && DIRECTIONS.some((item) => item.key === payload.direction)
        ? payload.direction as DirectionKey : null;
      const result: MoveResult = payload.result === "blocked" ? "blocked" : "moved";
      const nextPosition = pointPayload(payload.to, state.position);
      const relative = objectPayload(payload.relativePosition);
      const nextRelativePosition = typeof relative.x === "number" && typeof relative.y === "number"
        ? { x: relative.x, y: relative.y }
        : state.relativePosition;
      const won = payload.won === true;
      state = {
        ...state,
        position: nextPosition,
        relativePosition: nextRelativePosition,
        phase: "walker_think",
        turn: typeof event.turn === "number" ? event.turn : state.turn + 1,
        moves: state.moves + (result === "moved" ? 1 : 0),
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
      state = { ...state, turn: Math.max(state.turn, event.turn) };
      frames.push({ game: state, sequence: event.sequence, note: "Agent error", error: message });
    }
  }
  return frames;
}

async function fetchReplayRuns(signal?: AbortSignal, allowApiFallback = true): Promise<ReplayRunSummary[]> {
  let response = await fetch("/replay-data/index.json", { signal });
  if (!response.ok && allowApiFallback) response = await fetch("/api/replays", { signal });
  if (!response.ok) throw new Error("Could not load recorded runs.");
  const data = await response.json() as { runs?: ReplayRunSummary[] };
  return (data.runs ?? []).filter((run) => (run.max_turn ?? 0) > 0);
}

async function fetchReplay(runId: string, signal?: AbortSignal, allowApiFallback = true): Promise<ReplayDetail> {
  let response = await fetch(`/replay-data/runs/${encodeURIComponent(runId)}.json`, { signal });
  if (!response.ok && allowApiFallback) response = await fetch(`/api/replays?id=${encodeURIComponent(runId)}&compact=1`, { signal });
  if (!response.ok) throw new Error("Could not load this replay.");
  return response.json() as Promise<ReplayDetail>;
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

function PanelLabel({ children }: { children: ReactNode }) {
  return <span className="panel-label">{children}</span>;
}

function WalkerView({ game, hidden }: { game: ReplayGame; hidden: boolean }) {
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
              {isCenter ? <span className="local-walker">W</span> : null}
              {isExit ? <span className="local-exit-mark">EXIT</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SpectatorMap({ game, hidden }: { game: ReplayGame; hidden: boolean }) {
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

function MazeViewport({ game, showFullMap }: { game: ReplayGame; showFullMap: boolean }) {
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

function ThoughtStream({ history }: { history: WalkerTurn[] }) {
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.scrollTo({ top: stream.scrollHeight, behavior: history.length > 1 ? "smooth" : "auto" });
  }, [history.length]);
  return (
    <div className="thought-stream" aria-live="polite" ref={streamRef}>
      {history.length === 0 ? (
        <div className="thought-empty"><span>◎</span><p>Waiting for the Walker&apos;s first recorded observation.</p></div>
      ) : null}
      {history.map((entry, index) => {
        const direction = DIRECTIONS.find((item) => item.key === entry.action)?.label ?? entry.action;
        const outcome = entry.result === "blocked"
          ? "Awaiting move → Blocked — stayed in place"
          : entry.result === "moved"
            ? "Awaiting move → Move succeeded"
            : "Awaiting move";
        const animate = index === history.length - 1;
        const orientDelay = 0;
        const noteDelay = 1600;
        const actionDelay = 4000;
        const openDirections = entry.observation.openDirections.map((key) => DIRECTIONS.find((item) => item.key === key)?.label ?? key).join(", ") || "None";
        const blockedDirections = entry.observation.blockedDirections.map((key) => DIRECTIONS.find((item) => item.key === key)?.label ?? key).join(", ") || "None";
        const corridors = entry.observation.sightlines
          .filter((line) => line.distanceToWall > 0)
          .map((line) => `${DIRECTIONS.find((item) => item.key === line.direction)?.label ?? line.direction} ${line.distanceToWall} ${line.distanceToWall === 1 ? "cell" : "cells"}`)
          .join(" · ") || "None";

        return (
          <article className={`decision-card ${animate ? "is-current" : "is-complete"}`} key={entry.turn}>
            <header className="decision-card-head">
              <div className="turn-stamp"><span>TURN</span><strong>{String(entry.turn).padStart(2, "0")}</strong></div>
              <span className="response-badge">MODEL RESPONSE · 3 FIELDS</span>
            </header>

            <div className="environment-input">
              <div className="environment-input-head"><strong>ENVIRONMENT INPUT</strong><span>Provided by the maze</span></div>
              <div className="environment-input-grid">
                <span><small>OPEN</small>{openDirections}</span>
                <span><small>BLOCKED</small>{blockedDirections}</span>
                <span><small>VISIBLE CORRIDORS</small>{corridors}</span>
                <span><small>EXIT</small>{entry.observation.exitVisible ? "Visible" : "Not visible"}</span>
              </div>
            </div>

            <div className="decision-stage orient-stage">
              <div className="stage-marker"><span>01</span><i /></div>
              <div className="stage-content">
                <div className="stage-heading"><strong>ORIENT</strong><span>Where the model thinks it is · May be inaccurate</span></div>
                <div className="estimate-position"><span>ESTIMATED POSITION</span><strong><StreamingText text={`(${entry.estimatedPosition.x}, ${entry.estimatedPosition.y})`} animate={animate} delay={orientDelay} duration={260} placeholder="—" /></strong></div>
              </div>
            </div>

            <div className="decision-stage note-stage">
              <div className="stage-marker"><span>02</span><i /></div>
              <div className="stage-content">
                <div className="stage-heading"><strong>NOTES</strong><span>Model-written notes for later turns</span></div>
                <p><StreamingText text={entry.notes} animate={animate} delay={noteDelay} duration={1300} /></p>
              </div>
            </div>

            <div className="decision-stage act-stage">
              <div className="stage-marker"><span>03</span></div>
              <div className="stage-content">
                <div className="stage-heading"><strong>ACT</strong><span>Action selected by the model</span></div>
                <div className="act-readout">
                  <div className="act-output-row">
                    <span>MODEL OUTPUT</span>
                    <strong><StreamingText text={`MOVE ${direction.toUpperCase()}`} animate={animate} delay={actionDelay} duration={420} /></strong>
                  </div>
                  <div className="environment-result-row">
                    <span>ENVIRONMENT RESULT</span>
                    <em className={entry.result === "blocked" ? "is-blocked" : entry.result === null ? "is-pending" : ""}>{outcome}</em>
                  </div>
                </div>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function statusLabel(frame: ReplayFrame, runStatus: string, isLastFrame: boolean) {
  if (frame.game.status === "won" || (isLastFrame && runStatus === "won")) return "SOLVED";
  if (!isLastFrame) return frame.game.status === "ready" ? "STARTING" : "EXPLORING";
  if (frame.error && runStatus === "running") return "AGENT ERROR";
  if (runStatus === "running") return "RECORDED RUN";
  if (isLastFrame) return runStatus.replaceAll("_", " ").toUpperCase();
  return runStatus.replaceAll("_", " ").toUpperCase();
}

function ReplayObservation({ detail, frame, isLastFrame, showFullMap, onToggleMap, showReplayLink = false }: {
  detail: ReplayDetail;
  frame: ReplayFrame;
  isLastFrame: boolean;
  showFullMap: boolean;
  onToggleMap: () => void;
  showReplayLink?: boolean;
}) {
  const game = frame.game;
  const status = statusLabel(frame, detail.run.status, isLastFrame);
  return (
    <section className="observation-stage" aria-label="Recorded Echo Maze run">
      <div className="observation-head">
        <Link className="run-identity" href={`/replays/${encodeURIComponent(detail.run.id)}`}>
          <span>RECORDED RUN</span>
          <strong>{detail.run.model}</strong>
          <em>Maze {detail.run.mazeSeed}</em>
        </Link>
        <div className="observation-actions">
          {showReplayLink ? <Link className="button open-replay-button" href={`/replays/${encodeURIComponent(detail.run.id)}`}>Open replay <span>↗</span></Link> : null}
          <button className="button view-toggle public-map-toggle" type="button" aria-pressed={showFullMap} onClick={onToggleMap}>
            {showFullMap ? "Show Walker view" : "Show full map"}
          </button>
        </div>
      </div>

      <div className="agent-grid public-observation-grid">
        <article className="agent-card thought-card">
          <div className="card-head">
            <div className="agent-name-wrap"><div className="agent-avatar walker-avatar">W</div><div><PanelLabel>AGENT RESPONSE STREAM</PanelLabel><h2>How the Walker decides</h2></div></div>
            <span className="visibility-tag">3 STAGES</span>
          </div>
          <div className="thought-disclaimer">Each turn separates maze-provided input, model-written navigation state and action, and environment feedback—not hidden chain of thought.</div>
          <ThoughtStream history={game.history} />
        </article>
        <article className="agent-card public-maze-card">
          <div className="card-head">
            <div className="agent-name-wrap"><div className="agent-avatar walker-avatar">W</div><div><PanelLabel>WALKER VIEW</PanelLabel><h2>The Local Explorer</h2></div></div>
            <span className={`visibility-tag ${showFullMap ? "spectator-tag" : "local-tag"}`}>{showFullMap ? "SPECTATOR" : "LINE OF SIGHT"}</span>
          </div>
          <MazeViewport game={game} showFullMap={showFullMap} />
        </article>
      </div>

      <div className="live-metrics" aria-live="polite">
        <div><span>TURNS</span><strong>{game.turn}</strong></div>
        <div><span>MOVES</span><strong>{game.moves}</strong></div>
        <div><span>WALL HITS</span><strong>{game.collisions}</strong></div>
        <div className={`metric-status status-${status.toLowerCase().replaceAll(" ", "-")}`}><span>STATUS</span><strong>{status}</strong></div>
      </div>
    </section>
  );
}

function ReplayEmpty({ error }: { error?: string | null }) {
  return (
    <section className="replay-empty-state">
      <span>◎</span>
      <h2>{error ? "The replay channel is unavailable" : "No recorded runs yet"}</h2>
      <p>{error ?? "Completed runs will appear here after they are recorded."}</p>
      <Link href="/replays">Open Replay Library</Link>
    </section>
  );
}

export function HomeReplayChannel() {
  const [runs, setRuns] = useState<ReplayRunSummary[]>([]);
  const [runIndex, setRunIndex] = useState(0);
  const [detail, setDetail] = useState<ReplayDetail | null>(null);
  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [showFullMap, setShowFullMap] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchReplayRuns(controller.signal, false)
      .then((items) => { setRuns(items); setError(null); })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Could not load recorded runs."); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const selected = runs[runIndex];
    if (!selected) return undefined;
    const controller = new AbortController();
    fetchReplay(selected.id, controller.signal, false)
      .then((nextDetail) => {
        setDetail(nextDetail);
        setFrames(buildReplayFrames(nextDetail));
        setFrameIndex(0);
        setShowFullMap(false);
        setError(null);
      })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Could not load this replay."); });
    return () => controller.abort();
  }, [runIndex, runs]);

  useEffect(() => {
    if (!detail || frames.length < 2) return undefined;
    const atEnd = frameIndex >= frames.length - 1;
    const frameDelay = atEnd ? 4000 : frames[frameIndex]?.game.phase === "walker_move" ? 6800 : 2200;
    const timer = window.setTimeout(() => {
      if (atEnd && runs.length === 1) setFrameIndex(0);
      else if (atEnd) setRunIndex((index) => runs.length > 0 ? (index + 1) % runs.length : 0);
      else setFrameIndex((index) => Math.min(index + 1, frames.length - 1));
    }, frameDelay);
    return () => window.clearTimeout(timer);
  }, [detail, frameIndex, frames, runs.length]);

  if (error && !detail) return <ReplayEmpty error={error} />;
  const frame = frames[frameIndex];
  if (!detail || !frame) return <ReplayEmpty />;
  return <ReplayObservation detail={detail} frame={frame} isLastFrame={frameIndex === frames.length - 1} showFullMap={showFullMap} onToggleMap={() => setShowFullMap((value) => !value)} showReplayLink />;
}

export function ReplayLibrary() {
  const [runs, setRuns] = useState<ReplayRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchReplayRuns(controller.signal)
      .then((items) => { setRuns(items); setError(null); })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Could not load recorded runs."); });
    return () => controller.abort();
  }, []);
  if (error) return <ReplayEmpty error={error} />;
  if (runs.length === 0) return <ReplayEmpty />;
  return (
    <div className="replay-card-grid">
      {runs.map((run) => (
        <Link className="replay-card" href={`/replays/${encodeURIComponent(run.id)}`} key={run.id}>
          <div className="replay-card-top"><span>{run.model}</span><em>{run.status.replaceAll("_", " ")}</em></div>
          <h2>Maze {run.maze_seed}</h2>
          <div className="replay-card-metrics">
            <span><strong>{run.max_turn ?? 0}</strong> turns</span>
            <span><strong>{run.wall_hits ?? "—"}</strong> wall hits</span>
            <span><strong>{typeof run.spl === "number" ? run.spl.toFixed(3) : "—"}</strong> SPL</span>
          </div>
          <small>{new Date(run.created_at).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" })}</small>
        </Link>
      ))}
    </div>
  );
}

export function ReplayDetailViewer({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<ReplayDetail | null>(null);
  const [frames, setFrames] = useState<ReplayFrame[]>([]);
  const [frameIndex, setFrameIndex] = useState(0);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [playing, setPlaying] = useState(true);
  const [showFullMap, setShowFullMap] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchReplay(runId, controller.signal)
      .then((nextDetail) => { setDetail(nextDetail); setFrames(buildReplayFrames(nextDetail)); setError(null); })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error ? reason.message : "Could not load this replay."); });
    return () => controller.abort();
  }, [runId]);

  useEffect(() => {
    if (!playing || frames.length < 2 || frameIndex >= frames.length - 1) return undefined;
    const frameDelay = frames[frameIndex]?.game.phase === "walker_move" ? 6800 : 2200;
    const timer = window.setTimeout(() => setFrameIndex((index) => Math.min(index + 1, frames.length - 1)), frameDelay / speed);
    return () => window.clearTimeout(timer);
  }, [frameIndex, frames, playing, speed]);

  if (error) return <ReplayEmpty error={error} />;
  const frame = frames[frameIndex];
  if (!detail || !frame) return <ReplayEmpty />;
  return (
    <>
      <ReplayObservation detail={detail} frame={frame} isLastFrame={frameIndex === frames.length - 1} showFullMap={showFullMap} onToggleMap={() => setShowFullMap((value) => !value)} />
      <section className="detail-controls" aria-label="Replay controls">
        <button type="button" onClick={() => {
          if (frameIndex >= frames.length - 1) {
            setFrameIndex(0);
            setPlaying(true);
          } else {
            setPlaying((value) => !value);
          }
        }}>{playing && frameIndex < frames.length - 1 ? "Pause" : "Play"}</button>
        <label><span>SPEED</span><select value={speed} onChange={(event) => setSpeed(Number(event.target.value) as PlaybackSpeed)}>
          <option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option>
        </select></label>
        <label className="detail-timeline"><span>TURN SEQUENCE</span><input type="range" min={0} max={Math.max(0, frames.length - 1)} value={frameIndex} onChange={(event) => { setFrameIndex(Number(event.target.value)); setPlaying(false); }} /></label>
        <output>{frameIndex + 1} / {frames.length}</output>
      </section>
    </>
  );
}
