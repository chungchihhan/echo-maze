import { env } from "cloudflare:workers";

const MODEL = "gpt-5.6-luna";
const DIRECTIONS = ["up", "right", "down", "left"] as const;

type Direction = (typeof DIRECTIONS)[number];
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
  estimatedPosition: { x: number; y: number };
  notes: string;
  action: Direction;
  result: "moved" | "blocked" | null;
};
type AgentRequest = {
  role: "solo_walker";
  turn: number;
  observation: SoloWalkerObservation;
  conversation: SoloWalkerTurn[];
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
    if (payload.role !== "solo_walker") {
      return json({ error: "Unknown agent role." }, 400);
    }

    const result = await createStructuredResponse(
      apiKey,
      [
        "You are the Walker inside Echo Maze.",
        "Your goal is to reach the exit.",
        "You cannot see the complete maze, your absolute position, or any hidden state. You have no route-finding tool.",
        "Each turn, you receive your current local observation, open and blocked absolute directions, straight line-of-sight information, the result of your previous action, and the complete conversation from the current run.",
        "The starting cell is defined as relative position (0,0). A successful move right changes x by +1, left changes x by -1, up changes y by +1, and down changes y by -1. A blocked move does not change your position.",
        "Return exactly three fields.",
        "estimated_position: Your current estimate of your relative position. This is your own estimate and may be wrong.",
        "notes: Notes that will be included in later turns of this run. You may use this field in any way you find useful. Choose your own format and decide what is worth recording.",
        "action: Choose exactly one of up, right, down, or left.",
        "Explore the maze using your own strategy and reach the exit. Base your decisions only on the provided observations and conversation.",
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
          estimated_position: {
            type: "object",
            additionalProperties: false,
            properties: {
              x: { type: "integer", minimum: -100, maximum: 100 },
              y: { type: "integer", minimum: -100, maximum: 100 },
            },
            required: ["x", "y"],
          },
          notes: { type: "string", minLength: 1, maxLength: 280 },
          action: { type: "string", enum: DIRECTIONS },
        },
        required: ["estimated_position", "notes", "action"],
      },
      900,
      "low",
    );

    const notes = typeof result.data.notes === "string"
      ? result.data.notes.trim()
      : "";
    const estimatedPosition = result.data.estimated_position && typeof result.data.estimated_position === "object"
      ? result.data.estimated_position as { x?: unknown; y?: unknown }
      : null;
    if (!notes || !estimatedPosition
      || !Number.isInteger(estimatedPosition.x) || !Number.isInteger(estimatedPosition.y)
      || !isDirection(result.data.action)) {
      throw new Error("Solo Walker returned an invalid decision.");
    }
    return json({
      role: "solo_walker",
      model: MODEL,
      estimatedPosition: { x: estimatedPosition.x as number, y: estimatedPosition.y as number },
      notes,
      action: result.data.action,
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
