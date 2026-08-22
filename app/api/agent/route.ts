import { env } from "cloudflare:workers";

const MODEL = "gpt-5.6-luna";
const DIRECTIONS = ["up", "right", "down", "left"] as const;

type Direction = (typeof DIRECTIONS)[number];
type Point = { r: number; c: number };
type NavigatorMaze = {
  size: number;
  exit: Point;
  cells: Array<{ r: number; c: number; open: Direction[] }>;
};
type WalkerObservation = {
  openDirections: Direction[];
  blockedDirections: Direction[];
  sightlines: Array<{
    direction: Direction;
    distanceToWall: number;
    cells: Array<Point & {
      distance: number;
      openDirections: Direction[];
      isExit: boolean;
    }>;
  }>;
  exitVisible: boolean;
  lastAction: Direction | null;
  lastResult: "moved" | "blocked" | null;
  navigatorInstruction: string;
};
type SoloWalkerObservation = {
  openDirections: Direction[];
  blockedDirections: Direction[];
  sightlines: Array<{
    direction: Direction;
    distanceToWall: number;
    cells: Array<{
      distance: number;
      openDirections: Direction[];
      isExit: boolean;
    }>;
  }>;
  exitVisible: boolean;
  lastAction: Direction | null;
  lastResult: "moved" | "blocked" | null;
};
type SoloWalkerTurn = {
  turn: number;
  observation: SoloWalkerObservation;
  observationSummary: string;
  reasoning: string;
  believedPosition: { x: number; y: number };
  coordinateNote: string;
  direction: Direction;
  result: "moved" | "blocked" | null;
};
type AgentRequest =
  | {
      role: "solo_walker";
      turn: number;
      observation: SoloWalkerObservation;
      conversation: SoloWalkerTurn[];
    }
  | {
      role: "walker";
      turn: number;
      observation: WalkerObservation;
    }
  | {
      role: "walker_check";
      turn: number;
      instruction: string;
      direction: Direction | null;
      observation: WalkerObservation;
    }
  | {
      role: "navigator";
      turn: number;
      maze: NavigatorMaze;
      previousCandidates: Point[];
      conversation: Array<{
        actor: "walker" | "navigator";
        turn: number;
        kind: "report" | "instruction" | "verification" | "challenge";
        text: string;
      }>;
    };

type OpenAIResponse = {
  id?: string;
  status?: "completed" | "failed" | "in_progress" | "cancelled" | "queued" | "incomplete";
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  } | null;
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; refusal?: string }>;
  }>;
};

type AgentDiagnostic = {
  code: string;
  requestId: string | null;
  responseId: string | null;
  responseStatus: string | null;
  incompleteReason: string | null;
  attempts: number;
  timeoutMs: number;
  outputPreview?: string;
};

class AgentCallError extends Error {
  code: string;
  retryable: boolean;
  diagnostic: AgentDiagnostic;

  constructor(message: string, code: string, retryable: boolean, diagnostic: AgentDiagnostic) {
    super(message);
    this.name = "AgentCallError";
    this.code = code;
    this.retryable = retryable;
    this.diagnostic = diagnostic;
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function getOutput(response: OpenAIResponse) {
  if (response.output_text) return response.output_text;
  let refusal = "";
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
      if (content.type === "refusal" && content.refusal) refusal = content.refusal;
    }
  }
  if (refusal) return { refusal };
  return null;
}

function usageSummary(response: OpenAIResponse) {
  return {
    inputTokens: response.usage?.input_tokens ?? null,
    outputTokens: response.usage?.output_tokens ?? null,
    reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? null,
    totalTokens: response.usage?.total_tokens ?? null,
  };
}

async function createStructuredResponse(
  apiKey: string,
  instructions: string,
  input: unknown,
  schemaName: string,
  schema: Record<string, unknown>,
  maxOutputTokens: number,
  reasoningEffort: "none" | "low",
) {
  const timeoutMs = 90_000;
  let lastError: AgentCallError | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          instructions,
          input: JSON.stringify(input),
          reasoning: { effort: reasoningEffort },
          max_output_tokens: maxOutputTokens * attempt,
          store: false,
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: schemaName,
              strict: true,
              schema,
            },
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      lastError = new AgentCallError(
        timedOut
          ? `Agent response timed out after ${timeoutMs / 1000} seconds.`
          : "Could not reach the OpenAI API.",
        timedOut ? "timeout" : "network_error",
        true,
        {
          code: timedOut ? "timeout" : "network_error",
          requestId: null,
          responseId: null,
          responseStatus: null,
          incompleteReason: null,
          attempts: attempt,
          timeoutMs,
        },
      );
      if (attempt < 2) continue;
      throw lastError;
    }

    const requestId = response.headers.get("x-request-id");
    let body: OpenAIResponse;
    try {
      body = (await response.json()) as OpenAIResponse;
    } catch {
      lastError = new AgentCallError(
        "OpenAI returned an unreadable response.",
        "invalid_api_response",
        response.status >= 500,
        {
          code: "invalid_api_response",
          requestId,
          responseId: null,
          responseStatus: String(response.status),
          incompleteReason: null,
          attempts: attempt,
          timeoutMs,
        },
      );
      if (attempt < 2 && lastError.retryable) continue;
      throw lastError;
    }

    const diagnostic: AgentDiagnostic = {
      code: "unknown",
      requestId,
      responseId: body.id ?? null,
      responseStatus: body.status ?? String(response.status),
      incompleteReason: body.incomplete_details?.reason ?? null,
      attempts: attempt,
      timeoutMs,
    };

    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 409
        || response.status === 429 || response.status >= 500;
      lastError = new AgentCallError(
        body.error?.message ?? `OpenAI request failed with status ${response.status}.`,
        body.error?.code ?? `http_${response.status}`,
        retryable,
        { ...diagnostic, code: body.error?.code ?? `http_${response.status}` },
      );
      if (attempt < 2 && retryable) continue;
      throw lastError;
    }

    if (body.status === "incomplete") {
      const reason = body.incomplete_details?.reason ?? "unknown reason";
      lastError = new AgentCallError(
        `Agent output was incomplete (${reason}).`,
        "incomplete_output",
        true,
        { ...diagnostic, code: "incomplete_output" },
      );
      if (attempt < 2) continue;
      throw lastError;
    }

    const output = getOutput(body);
    if (output && typeof output === "object") {
      throw new AgentCallError(
        `Agent refused the request: ${output.refusal}`,
        "refusal",
        false,
        { ...diagnostic, code: "refusal" },
      );
    }
    if (!output) {
      lastError = new AgentCallError(
        "The model completed without a text output.",
        "missing_output_text",
        true,
        { ...diagnostic, code: "missing_output_text" },
      );
      if (attempt < 2) continue;
      throw lastError;
    }

    try {
      return {
        data: JSON.parse(output) as Record<string, unknown>,
        meta: {
          model: MODEL,
          requestId,
          responseId: body.id ?? null,
          status: body.status ?? "completed",
          attempts: attempt,
          latencyMs: Date.now() - startedAt,
          usage: usageSummary(body),
        },
      };
    } catch {
      lastError = new AgentCallError(
        "The model returned truncated or invalid structured JSON.",
        "invalid_structured_json",
        true,
        {
          ...diagnostic,
          code: "invalid_structured_json",
          outputPreview: output.slice(0, 240),
        },
      );
      if (attempt < 2) continue;
      throw lastError;
    }
  }

  throw lastError ?? new Error("Agent request failed.");
}

function isDirection(value: unknown): value is Direction {
  return typeof value === "string" && DIRECTIONS.includes(value as Direction);
}

function normalizeCandidates(value: unknown, size: number) {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, Point>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const { r, c } = candidate as Partial<Point>;
    if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
    if ((r as number) < 0 || (r as number) >= size || (c as number) < 0 || (c as number) >= size) continue;
    unique.set(`${r},${c}`, { r: r as number, c: c as number });
  }
  return [...unique.values()].slice(0, size * size);
}

function pointKey(point: Point) {
  return `${point.r},${point.c}`;
}

function routeBetween(maze: NavigatorMaze, start: Point, goal: Point) {
  const cells = new Map(maze.cells.map((cell) => [pointKey(cell), cell]));
  if (!cells.has(pointKey(start)) || !cells.has(pointKey(goal))) return [];

  const vectors: Record<Direction, Point> = {
    up: { r: -1, c: 0 },
    right: { r: 0, c: 1 },
    down: { r: 1, c: 0 },
    left: { r: 0, c: -1 },
  };
  const queue = [start];
  const previous = new Map<string, Point | null>([[pointKey(start), null]]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || pointKey(current) === pointKey(goal)) break;
    const cell = cells.get(pointKey(current));
    if (!cell) continue;

    for (const direction of cell.open) {
      const vector = vectors[direction];
      const next = { r: current.r + vector.r, c: current.c + vector.c };
      if (!cells.has(pointKey(next)) || previous.has(pointKey(next))) continue;
      previous.set(pointKey(next), current);
      queue.push(next);
    }
  }

  if (!previous.has(pointKey(goal))) return [];
  const route: Point[] = [];
  let cursor: Point | null = goal;
  while (cursor) {
    route.unshift(cursor);
    cursor = previous.get(pointKey(cursor)) ?? null;
  }
  return route;
}

function directionBetween(from: Point, to: Point): Direction | null {
  const rowDelta = to.r - from.r;
  const columnDelta = to.c - from.c;
  if (rowDelta === -1 && columnDelta === 0) return "up";
  if (rowDelta === 1 && columnDelta === 0) return "down";
  if (rowDelta === 0 && columnDelta === 1) return "right";
  if (rowDelta === 0 && columnDelta === -1) return "left";
  return null;
}

export async function POST(request: Request) {
  const apiKey = (env as unknown as { OPENAI_API_KEY?: string }).OPENAI_API_KEY;
  if (!apiKey) return json({ error: "OPENAI_API_KEY is not configured on the server." }, 503);

  let payload: AgentRequest;
  try {
    payload = (await request.json()) as AgentRequest;
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  try {
    if (payload.role === "solo_walker") {
      const result = await createStructuredResponse(
        apiKey,
        [
          "You are the only agent inside Echo Maze.",
          "You cannot see a map, your absolute coordinates, or any hidden state. You have no route tool and no notebook.",
          "Your sole memory is the complete conversation from this run: prior observations, your prior reasoning summaries and decisions, and movement outcomes.",
          "Maintain your own relative coordinate system in that conversation. The starting cell is (0,0); moving right changes x by +1, left changes x by -1, up changes y by +1, and down changes y by -1.",
          "A successful prior move changes your coordinate by exactly one. A blocked prior move leaves it unchanged. Recalculate your current believed coordinate from the history every turn.",
          "Write one coordinate note for the current cell that records useful open directions, explored branches, dead ends, or a possible revisit. This note becomes part of the next turn's conversation.",
          "The current observation shows open and blocked absolute directions plus straight line-of-sight corridors. A wall hides everything beyond it.",
          "Use the conversation to build and revise a mental route: remember branches already attempted, recognize likely revisits from matching views and action history, and backtrack from dead ends.",
          "Never claim certainty about a location or unseen geometry. Never invent coordinates.",
          "If the exit is visible, choose the open direction whose sightline contains isExit=true.",
          "Otherwise prefer an open branch you believe has not been explored; when necessary, deliberately backtrack.",
          "Return a concise English observation summary and a concise, useful English reasoning summary that makes your memory strategy observable.",
          "Write the coordinate note in English as well.",
          "Choose exactly one direction from the currently open directions.",
        ].join(" "),
        {
          turn: payload.turn,
          currentObservation: payload.observation,
          conversation: payload.conversation,
        },
        "solo_walker_decision",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            observation_summary: { type: "string", minLength: 1, maxLength: 220 },
            reasoning_summary: { type: "string", minLength: 1, maxLength: 360 },
            believed_position: {
              type: "object",
              additionalProperties: false,
              properties: {
                x: { type: "integer", minimum: -100, maximum: 100 },
                y: { type: "integer", minimum: -100, maximum: 100 },
              },
              required: ["x", "y"],
            },
            coordinate_note: { type: "string", minLength: 1, maxLength: 280 },
            direction: { type: "string", enum: DIRECTIONS },
          },
          required: ["observation_summary", "reasoning_summary", "believed_position", "coordinate_note", "direction"],
        },
        900,
        "low",
      );

      const observationSummary = typeof result.data.observation_summary === "string"
        ? result.data.observation_summary.trim()
        : "";
      const reasoning = typeof result.data.reasoning_summary === "string"
        ? result.data.reasoning_summary.trim()
        : "";
      const coordinateNote = typeof result.data.coordinate_note === "string"
        ? result.data.coordinate_note.trim()
        : "";
      const believedPosition = result.data.believed_position && typeof result.data.believed_position === "object"
        ? result.data.believed_position as { x?: unknown; y?: unknown }
        : null;
      if (!observationSummary || !reasoning || !coordinateNote || !believedPosition
        || !Number.isInteger(believedPosition.x) || !Number.isInteger(believedPosition.y)
        || !isDirection(result.data.direction)) {
        throw new Error("Solo Walker returned an invalid decision.");
      }
      if (!payload.observation.openDirections.includes(result.data.direction)) {
        throw new Error("Solo Walker selected a direction that is visibly blocked.");
      }

      return json({
        role: "solo_walker",
        model: MODEL,
        observationSummary,
        reasoning,
        believedPosition: { x: believedPosition.x as number, y: believedPosition.y as number },
        coordinateNote,
        direction: result.data.direction,
        meta: result.meta,
      });
    }

    if (payload.role === "walker") {
      const result = await createStructuredResponse(
        apiKey,
        [
          "You are Walker in Echo Maze.",
          "You do not know your absolute row or column and must never invent coordinates.",
          "You only know the supplied line-of-sight observation and the Navigator's latest instruction.",
          "Each sightline tells you how many cells are visible before a wall and which side passages are visible along that straight corridor.",
          "Give Navigator one precise Traditional Chinese sentence describing the previous move outcome, corridor distances, useful visible junctions, and a visible exit if present.",
          "Do not add facts that are absent from the observation.",
        ].join(" "),
        { turn: payload.turn, ...payload.observation },
        "walker_report",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            report: { type: "string", minLength: 1, maxLength: 260 },
          },
          required: ["report"],
        },
        600,
        "none",
      );
      const report = typeof result.data.report === "string" ? result.data.report.trim() : "";
      if (!report) throw new Error("Walker returned an empty report.");
      return json({ role: "walker", model: MODEL, report, meta: result.meta });
    }

    if (payload.role === "walker_check") {
      if (!payload.direction || !isDirection(payload.direction)) {
        return json({ error: "Walker received no valid movement direction." }, 400);
      }
      const result = await createStructuredResponse(
        apiKey,
        [
          "You are Walker in Echo Maze and must verify Navigator's instruction before moving.",
          "You know only the supplied line-of-sight observation; never invent coordinates or unseen facts.",
          "Challenge the instruction if its movement direction is blocked by a wall.",
          "Also challenge it if Navigator explicitly claims the exit is currently visible in a direction but your sightlines contradict that claim.",
          "Do not challenge merely because Navigator says a direction leads toward or closer to an unseen exit; that is routing advice, not a claim of current visibility.",
          "If the instruction is locally possible and not contradicted, choose move.",
          "Reply in one concise Traditional Chinese sentence explaining what you can verify.",
        ].join(" "),
        {
          turn: payload.turn,
          instruction: payload.instruction,
          proposedDirection: payload.direction,
          observation: payload.observation,
        },
        "walker_instruction_check",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            decision: { type: "string", enum: ["move", "challenge"] },
            message: { type: "string", minLength: 1, maxLength: 180 },
          },
          required: ["decision", "message"],
        },
        600,
        "none",
      );
      let decision = result.data.decision === "challenge" ? "challenge" : "move";
      let message = typeof result.data.message === "string" ? result.data.message.trim() : "";

      if (payload.observation.blockedDirections.includes(payload.direction)) {
        decision = "challenge";
        const directionLabel = { up: "上", right: "右", down: "下", left: "左" }[payload.direction];
        message = `${directionLabel}方是牆，我無法照這個方向移動，請重新判斷我的位置。`;
      }
      if (!message) throw new Error("Walker returned an empty verification message.");

      return json({
        role: "walker_check",
        model: MODEL,
        decision,
        message,
        meta: result.meta,
      });
    }

    if (payload.role !== "navigator" || !payload.maze) {
      return json({ error: "Unknown agent role." }, 400);
    }

    const result = await createStructuredResponse(
      apiKey,
      [
        "You are Navigator in Echo Maze.",
        "You see the complete maze and exit, but you never receive Walker's true start or live position.",
        "Infer Walker's possible zero-based coordinates only from the maze, Walker reports, and your prior instructions.",
        "Treat previousCandidates as a revisable belief, not a hard constraint; if any new report, movement outcome, or challenge contradicts them, rebuild the candidate set from the full conversation.",
        "Keep every still-plausible candidate in candidate_positions; do not pretend localization is certain.",
        "Your primary task is localization. Choose exactly one probing direction while multiple positions remain plausible.",
        "When exactly one well-supported candidate remains, a deterministic route tool will replace your proposed movement with the correct next route step from that claimed position.",
        "The message must be one concise Traditional Chinese sentence and must match direction.",
      ].join(" "),
      {
        turn: payload.turn,
        coordinateSystem: "zero-based rows increase downward; columns increase rightward",
        maze: payload.maze,
        previousCandidates: payload.previousCandidates,
        conversation: payload.conversation,
      },
      "navigator_instruction",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          message: { type: "string", minLength: 1, maxLength: 120 },
          direction: { type: "string", enum: DIRECTIONS },
          candidate_positions: {
            type: "array",
            maxItems: 81,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                r: { type: "integer", minimum: 0, maximum: 8 },
                c: { type: "integer", minimum: 0, maximum: 8 },
              },
              required: ["r", "c"],
            },
          },
        },
        required: ["message", "direction", "candidate_positions"],
      },
      2600,
      "low",
    );

    let message = typeof result.data.message === "string" ? result.data.message.trim() : "";
    if (!message || !isDirection(result.data.direction)) {
      throw new Error("Navigator returned an invalid instruction.");
    }

    const candidates = normalizeCandidates(result.data.candidate_positions, payload.maze.size);
    let direction = result.data.direction;
    let navigationMode: "localizing" | "routing" = "localizing";
    let route: Point[] = [];

    if (candidates.length === 1) {
      const claimedRoute = routeBetween(payload.maze, candidates[0], payload.maze.exit);
      const routeDirection = claimedRoute.length >= 2
        ? directionBetween(claimedRoute[0], claimedRoute[1])
        : null;
      if (routeDirection) {
        navigationMode = "routing";
        route = claimedRoute;
        direction = routeDirection;
        const directionLabel = { up: "上", right: "右", down: "下", left: "左" }[direction];
        message = `位置假設已鎖定；依規劃路線請向${directionLabel}移動一格。`;
      }
    }

    return json({
      role: "navigator",
      model: MODEL,
      message,
      direction,
      candidates,
      navigationMode,
      route,
      meta: result.meta,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent request failed.";
    console.error("Echo Maze agent error:", message);
    if (error instanceof AgentCallError) {
      return json({
        error: message,
        code: error.code,
        retryable: error.retryable,
        diagnostic: error.diagnostic,
      }, 502);
    }
    return json({ error: message, code: "agent_error", retryable: false }, 502);
  }
}
