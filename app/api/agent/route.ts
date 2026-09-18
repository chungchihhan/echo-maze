import { env } from "cloudflare:workers";

import { createTypeSafeClient, formatChoiceNotes, buildVisitedKeys, preferUnvisitedDirections, relativeKey, relativeNeighbor } from "../../../lib/ai/typesafe-client.js";
import { createEchoMazeAIClient } from "../../../lib/ai/vercel-client.js";
import {
  RESPONSE_SCHEMA,
  RESPONSE_SCHEMA_NAME,
  WALKER_DIRECTIONS,
  WALKER_PROMPT,
} from "../../../lib/ai/walker-decision.js";

const OPENAI_MODEL = "gpt-5.6-luna";
const TYPESAFE_MODEL = "jev-latest";
const DIRECTIONS = WALKER_DIRECTIONS as readonly ["up", "right", "down", "left"];

type Direction = (typeof DIRECTIONS)[number];
type AgentProvider = "openai" | "typesafe";
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
  provider?: AgentProvider;
  turn: number;
  observation: SoloWalkerObservation;
  relativePosition?: { x: number; y: number };
  conversation: Array<SoloWalkerTurn | Record<string, unknown>>;
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

function readBindings() {
  return env as unknown as {
    ENABLE_LIVE_API?: string;
    OPENAI_API_KEY?: string;
    TYPESAFE_AI_API_KEY?: string;
    TYPESAFE_API_KEY?: string;
  };
}

function typeSafeApiKey(bindings: ReturnType<typeof readBindings>) {
  return bindings.TYPESAFE_AI_API_KEY || bindings.TYPESAFE_API_KEY || "";
}

function isDirection(value: unknown): value is Direction {
  return typeof value === "string" && DIRECTIONS.includes(value as Direction);
}

function asPoint(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== "object") return null;
  const point = value as { x?: unknown; y?: unknown };
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) return null;
  return { x: point.x as number, y: point.y as number };
}

function normalizeConversation(conversation: AgentRequest["conversation"]): SoloWalkerTurn[] {
  const turns: SoloWalkerTurn[] = [];
  for (const entry of conversation ?? []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const action = record.action ?? record.direction;
    const estimatedPosition = asPoint(record.estimatedPosition ?? record.believedPosition);
    const notes = typeof record.notes === "string"
      ? record.notes
      : typeof record.reasoning === "string"
        ? record.reasoning
        : "";
    const observation = record.observation as SoloWalkerObservation | undefined;
    if (!observation || !estimatedPosition || !isDirection(action) || !notes) continue;
    turns.push({
      turn: typeof record.turn === "number" ? record.turn : turns.length + 1,
      observation,
      estimatedPosition,
      notes,
      action,
      result: record.result === "moved" || record.result === "blocked" ? record.result : null,
    });
  }
  return turns;
}

function summarizeObservation(observation: SoloWalkerObservation) {
  const open = observation.openDirections.join(", ") || "none";
  const blocked = observation.blockedDirections.join(", ") || "none";
  const exit = observation.exitVisible ? "Exit is visible in line of sight." : "Exit is not visible.";
  const last = observation.lastAction
    ? `Last action ${observation.lastAction} was ${observation.lastResult ?? "unknown"}.`
    : "No previous action.";
  return `Open: ${open}. Blocked: ${blocked}. ${exit} ${last}`;
}

function usageSummary(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  output_tokens_details?: { reasoning_tokens?: number };
} | null) {
  return {
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? null,
    totalTokens: usage?.total_tokens ?? (
      typeof usage?.input_tokens === "number" && typeof usage?.output_tokens === "number"
        ? usage.input_tokens + usage.output_tokens
        : null
    ),
  };
}

async function createOpenAIDecision(apiKey: string, input: unknown) {
  const timeoutMs = 90_000;
  const client = createEchoMazeAIClient({
    provider: "openai",
    apiKey,
    model: OPENAI_MODEL,
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
          model: OPENAI_MODEL,
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

async function createTypeSafeDecision(
  apiKey: string,
  payload: AgentRequest,
  conversation: SoloWalkerTurn[],
  estimatedPosition: { x: number; y: number },
) {
  const timeoutMs = 30_000;
  const client = createTypeSafeClient({ apiKey, model: TYPESAFE_MODEL });
  let lastError: AgentCallError | null = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const visitedKeys = buildVisitedKeys(conversation, estimatedPosition);
    const candidateDirections = preferUnvisitedDirections(
      payload.observation.openDirections,
      estimatedPosition,
      visitedKeys,
    );
    const forcingBacktrack = payload.observation.openDirections.every((direction) => (
      visitedKeys.has(relativeKey(relativeNeighbor(estimatedPosition, direction)))
    ));

    const result = await client.chooseDirection({
      openDirections: candidateDirections,
      timeoutMs,
      state: {
        goal: "Reach the exit using only local corridor observations and relative coordinates.",
        turn: payload.turn,
        relativePosition: estimatedPosition,
        visitedRelativeKeys: [...visitedKeys],
        visitedCount: visitedKeys.size,
        candidateDirections,
        explorationPolicy: forcingBacktrack
          ? "All open neighbors are already visited; backtracking is allowed."
          : "Candidate directions are restricted to unvisited relative neighbors when any exist.",
        currentObservation: payload.observation,
        recentTurns: conversation.slice(-12).map((turn) => ({
          turn: turn.turn,
          action: turn.action,
          result: turn.result,
          estimatedPosition: turn.estimatedPosition,
          notes: turn.notes,
        })),
        coordinateRules: {
          start: { x: 0, y: 0 },
          right: "+x",
          left: "-x",
          up: "+y",
          down: "-y",
          blockedMove: "position unchanged",
        },
      },
    });

    if (result.ok) {
      const notes = formatChoiceNotes(result.data);
      /** @type {Record<string, number>} */
      const probabilities: Record<string, number> = {};
      for (const direction of payload.observation.openDirections) {
        probabilities[direction] = result.data.probabilities[direction] ?? 0;
      }
      return {
        data: {
          estimated_position: estimatedPosition,
          notes,
          action: result.data.choice,
        },
        decision: {
          probabilities,
          confidence: result.data.confidence,
          source: result.data.source,
          candidates: candidateDirections,
          visitedCount: visitedKeys.size,
        },
        meta: {
          model: result.meta.model,
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
    const retryable = Boolean(result.error.retryable);
    lastError = new AgentCallError(
      agentErrorMessage(code, timeoutMs, result.error.message),
      code,
      retryable,
      {
        code,
        requestId: result.error.meta?.requestId ?? null,
        responseId: result.error.meta?.responseId ?? null,
        responseStatus: result.error.meta?.status ?? null,
        incompleteReason: null,
        attempts: attempt,
        timeoutMs,
        ...(result.error.rawOutput ? { outputPreview: result.error.rawOutput } : {}),
      },
    );
    if (attempt < 2 && retryable) continue;
    throw lastError;
  }

  throw lastError ?? new Error("TypeSafe agent request failed.");
}

function agentErrorMessage(code: string, timeoutMs: number, fallback: string) {
  if (code === "timeout") return `Agent response timed out after ${timeoutMs / 1000} seconds.`;
  if (code === "network_error") return "Could not reach the model API.";
  if (code === "incomplete_output") return "Agent output was incomplete (max_output_tokens).";
  if (code === "missing_output_text") return "The model completed without a text output.";
  if (code === "invalid_structured_json") return "The model returned truncated or invalid structured JSON.";
  if (code === "refusal") return `Agent refused the request: ${fallback}`;
  if (code === "authentication_error") return "TypeSafe API authentication failed.";
  return fallback || "Agent request failed.";
}

export async function POST(request: Request) {
  const bindings = readBindings();
  if (bindings.ENABLE_LIVE_API !== "true") {
    return json({ error: "Not found." }, 404);
  }

  let payload: AgentRequest;
  try {
    payload = (await request.json()) as AgentRequest;
  } catch {
    return json({ error: "Invalid JSON request." }, 400);
  }

  const provider: AgentProvider = payload.provider === "typesafe" ? "typesafe" : "openai";

  try {
    if (payload.role !== "solo_walker") {
      return json({ error: "Unknown agent role." }, 400);
    }
    if (!payload.observation || !Array.isArray(payload.observation.openDirections)) {
      return json({ error: "Invalid walker observation." }, 400);
    }

    const conversation = normalizeConversation(payload.conversation);
    const estimatedPosition = asPoint(payload.relativePosition)
      ?? conversation.at(-1)?.estimatedPosition
      ?? { x: 0, y: 0 };

    if (provider === "typesafe") {
      const apiKey = typeSafeApiKey(bindings);
      if (!apiKey) {
        return json({ error: "TYPESAFE_AI_API_KEY is not configured on the server." }, 503);
      }
      if (payload.observation.openDirections.length === 0) {
        return json({ error: "No open directions available." }, 400);
      }

      const result = await createTypeSafeDecision(apiKey, payload, conversation, estimatedPosition);
      const notes = typeof result.data.notes === "string" ? result.data.notes.trim() : "";
      if (!notes || !isDirection(result.data.action)) {
        throw new Error("Solo Walker returned an invalid decision.");
      }

      return json({
        role: "solo_walker",
        provider,
        model: result.meta.model,
        estimatedPosition,
        believedPosition: estimatedPosition,
        notes,
        reasoning: notes,
        observationSummary: summarizeObservation(payload.observation),
        coordinateNote: `Relative position maintained in code at (${estimatedPosition.x}, ${estimatedPosition.y}).`,
        action: result.data.action,
        direction: result.data.action,
        decision: result.decision,
        meta: result.meta,
      });
    }

    const apiKey = bindings.OPENAI_API_KEY;
    if (!apiKey) return json({ error: "OPENAI_API_KEY is not configured on the server." }, 503);

    const result = await createOpenAIDecision(apiKey, {
      turn: payload.turn,
      currentObservation: payload.observation,
      conversation,
    });

    const notes = typeof result.data.notes === "string" ? result.data.notes.trim() : "";
    const modelPosition = asPoint(result.data.estimated_position);
    if (!notes || !modelPosition || !isDirection(result.data.action)) {
      throw new Error("Solo Walker returned an invalid decision.");
    }

    return json({
      role: "solo_walker",
      provider,
      model: OPENAI_MODEL,
      estimatedPosition: modelPosition,
      believedPosition: modelPosition,
      notes,
      reasoning: notes,
      observationSummary: summarizeObservation(payload.observation),
      coordinateNote: notes,
      action: result.data.action,
      direction: result.data.action,
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
