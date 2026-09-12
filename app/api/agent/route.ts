import { env } from "cloudflare:workers";

import { createEchoMazeAIClient } from "../../../lib/ai/vercel-client.js";
import {
  RESPONSE_SCHEMA,
  RESPONSE_SCHEMA_NAME,
  WALKER_DIRECTIONS,
  WALKER_PROMPT,
} from "../../../lib/ai/walker-decision.js";

const MODEL = "gpt-5.6-luna";
const DIRECTIONS = WALKER_DIRECTIONS as readonly ["up", "right", "down", "left"];

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

async function createStructuredResponse(apiKey: string, input: unknown) {
  const timeoutMs = 90_000;
  const client = createEchoMazeAIClient({
    provider: "openai",
    apiKey,
    model: MODEL,
    appName: "Echo Maze",
  });
  let lastError: AgentCallError | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = await client.generateStructured({
      instructions: WALKER_PROMPT,
      input: JSON.stringify(input),
      schemaName: RESPONSE_SCHEMA_NAME,
      schema: RESPONSE_SCHEMA,
      maxOutputTokens: 900 * attempt,
      reasoningEffort: "low",
      timeoutMs,
    });

    if (result.ok) {
      return {
        data: result.data as Record<string, unknown>,
        meta: {
          model: MODEL,
          requestId: result.meta.requestId,
          responseId: result.meta.responseId,
          status: result.meta.status ?? "completed",
          attempts: attempt,
          latencyMs: result.meta.latencyMs,
          usage: usageSummary(result.meta.usage),
        },
      };
    }

    const code = result.error.category;
    const retryable = result.error.retryable || code === "invalid_structured_json";
    lastError = new AgentCallError(
      agentErrorMessage(code, timeoutMs, result.error.message),
      code,
      retryable,
      {
        code,
        requestId: result.error.meta.requestId,
        responseId: result.error.meta.responseId,
        responseStatus: result.error.meta.status,
        incompleteReason: code === "incomplete_output" ? "max_output_tokens" : null,
        attempts: attempt,
        timeoutMs,
        ...(result.error.rawOutput ? { outputPreview: result.error.rawOutput.slice(0, 240) } : {}),
      },
    );
    if (attempt < 2 && retryable) continue;
    throw lastError;
  }

  throw lastError ?? new Error("Agent request failed.");
}

function usageSummary(usage: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
} | null) {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? null,
  };
}

function agentErrorMessage(code: string, timeoutMs: number, fallback: string) {
  if (code === "timeout") return `Agent response timed out after ${timeoutMs / 1000} seconds.`;
  if (code === "network_error") return "Could not reach the OpenAI API.";
  if (code === "incomplete_output") return "Agent output was incomplete (max_output_tokens).";
  if (code === "missing_output_text") return "The model completed without a text output.";
  if (code === "invalid_structured_json") return "The model returned truncated or invalid structured JSON.";
  if (code === "refusal") return `Agent refused the request: ${fallback}`;
  return fallback || "Agent request failed.";
}

function isDirection(value: unknown): value is Direction {
  return typeof value === "string" && DIRECTIONS.includes(value as Direction);
}

export async function POST(request: Request) {
  const bindings = env as unknown as {
    ENABLE_LIVE_API?: string;
    OPENAI_API_KEY?: string;
  };
  if (bindings.ENABLE_LIVE_API !== "true") {
    return json({ error: "Not found." }, 404);
  }

  const apiKey = bindings.OPENAI_API_KEY;
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

    const result = await createStructuredResponse(apiKey, {
      turn: payload.turn,
      currentObservation: payload.observation,
      conversation: payload.conversation,
    });

    const notes = typeof result.data.notes === "string" ? result.data.notes.trim() : "";
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
