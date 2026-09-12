import { env } from "cloudflare:workers";

type ReplayAction =
  | {
      action: "create";
      runId: string;
      createdAt: number;
      model: string;
      mazeSeed: string;
      maze: unknown;
      initialPosition: unknown;
    }
  | {
      action: "event";
      runId: string;
      sequence: number;
      createdAt: number;
      turn: number;
      phase: string;
      type: string;
      payload: unknown;
    }
  | {
      action: "finish";
      runId: string;
      updatedAt: number;
      status: "won" | "abandoned" | "stopped";
    };

type ReplayRunRow = {
  id: string;
  created_at: number;
  updated_at: number;
  status: string;
  model: string;
  maze_seed: string;
  maze_json: string;
  initial_position_json: string;
};

type ReplayEventRow = {
  run_id: string;
  sequence: number;
  created_at: number;
  turn: number;
  phase: string;
  type: string;
  payload_json: string;
};

type ReplayRunSummaryRow = Omit<ReplayRunRow, "maze_json" | "initial_position_json"> & {
  event_count: number;
  max_turn: number | null;
  had_error: number;
};

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function database() {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new Error("Replay database is unavailable.");
  return db;
}

function liveApiEnabled() {
  return (env as unknown as { ENABLE_LIVE_API?: string }).ENABLE_LIVE_API === "true";
}

async function ensureReplayTables(db: D1Database) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS replay_runs (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        maze_seed TEXT NOT NULL,
        maze_json TEXT NOT NULL,
        initial_position_json TEXT NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS replay_events (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        turn INTEGER NOT NULL,
        phase TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS replay_events_run_sequence_idx
      ON replay_events (run_id, sequence)
    `),
  ]);
}

function parseStoredJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function compactEventPayload(type: string, payload: unknown) {
  if (type !== "agent_request" || !payload || typeof payload !== "object") return payload;
  const request = payload as Record<string, unknown>;
  return {
    role: request.role,
    turn: request.turn,
    observation: request.observation,
    instruction: request.instruction,
    direction: request.direction,
  };
}

export async function GET(request: Request) {
  if (!liveApiEnabled()) return json({ error: "Not found." }, 404);

  try {
    const db = database();
    await ensureReplayTables(db);
    const searchParams = new URL(request.url).searchParams;
    const runId = searchParams.get("id");
    const compact = searchParams.get("compact") === "1";

    if (!runId) {
      const rows = await db.prepare(`
        SELECT
          r.id,
          r.created_at,
          r.updated_at,
          r.status,
          r.model,
          r.maze_seed,
          COUNT(e.sequence) AS event_count,
          SUM(CASE WHEN e.type IN ('solo_walker_move', 'environment_move') THEN 1 ELSE 0 END) AS max_turn,
          MAX(CASE WHEN e.type = 'agent_error' THEN 1 ELSE 0 END) AS had_error
        FROM replay_runs r
        LEFT JOIN replay_events e ON e.run_id = r.id
        GROUP BY r.id, r.created_at, r.updated_at, r.status, r.model, r.maze_seed
        HAVING SUM(CASE WHEN e.type IN ('solo_walker_move', 'environment_move') THEN 1 ELSE 0 END) > 0
        ORDER BY r.created_at DESC
        LIMIT 30
      `).all<ReplayRunSummaryRow>();
      return json({ runs: rows.results });
    }

    const run = await db.prepare(`
      SELECT id, created_at, updated_at, status, model, maze_seed, maze_json, initial_position_json
      FROM replay_runs
      WHERE id = ?
    `).bind(runId).first<ReplayRunRow>();
    if (!run) return json({ error: "Replay run not found." }, 404);

    const events = await db.prepare(`
      SELECT run_id, sequence, created_at, turn, phase, type, payload_json
      FROM replay_events
      WHERE run_id = ?
      ORDER BY sequence ASC
    `).bind(runId).all<ReplayEventRow>();

    return json({
      version: 1,
      run: {
        id: run.id,
        createdAt: run.created_at,
        updatedAt: run.updated_at,
        status: run.status,
        model: run.model,
        mazeSeed: run.maze_seed,
        maze: parseStoredJson(run.maze_json),
        initialPosition: parseStoredJson(run.initial_position_json),
      },
      events: events.results.map((event) => ({
        sequence: event.sequence,
        createdAt: event.created_at,
        turn: event.turn,
        phase: event.phase,
        type: event.type,
        payload: compact
          ? compactEventPayload(event.type, parseStoredJson(event.payload_json))
          : parseStoredJson(event.payload_json),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read replay data.";
    return json({ error: message }, 500);
  }
}

export async function POST(request: Request) {
  if (!liveApiEnabled()) return json({ error: "Not found." }, 404);

  let payload: ReplayAction;
  try {
    payload = (await request.json()) as ReplayAction;
  } catch {
    return json({ error: "Invalid replay payload." }, 400);
  }

  try {
    const db = database();
    await ensureReplayTables(db);

    if (payload.action === "create") {
      await db.prepare(`
        INSERT INTO replay_runs (
          id, created_at, updated_at, status, model, maze_seed, maze_json, initial_position_json
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)
      `).bind(
        payload.runId,
        payload.createdAt,
        payload.createdAt,
        payload.model,
        payload.mazeSeed,
        JSON.stringify(payload.maze),
        JSON.stringify(payload.initialPosition),
      ).run();
      return json({ ok: true, runId: payload.runId }, 201);
    }

    if (payload.action === "event") {
      await db.batch([
        db.prepare(`
          INSERT OR IGNORE INTO replay_events (
            run_id, sequence, created_at, turn, phase, type, payload_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          payload.runId,
          payload.sequence,
          payload.createdAt,
          payload.turn,
          payload.phase,
          payload.type,
          JSON.stringify(payload.payload),
        ),
        db.prepare("UPDATE replay_runs SET updated_at = ? WHERE id = ?")
          .bind(payload.createdAt, payload.runId),
      ]);
      return json({ ok: true });
    }

    if (payload.action === "finish") {
      await db.prepare("UPDATE replay_runs SET updated_at = ?, status = ? WHERE id = ?")
        .bind(payload.updatedAt, payload.status, payload.runId)
        .run();
      return json({ ok: true });
    }

    return json({ error: "Unknown replay action." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save replay data.";
    console.error("Echo Maze replay error:", message);
    return json({ error: message }, 500);
  }
}
