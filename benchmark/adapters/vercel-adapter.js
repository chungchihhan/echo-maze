/**
 * Benchmark policy around the shared Vercel AI SDK transport. The SDK performs
 * exactly one HTTP call per invocation; this adapter owns retries, pacing,
 * tolerant output extraction, and append-only attempt diagnostics.
 */

import { createEchoMazeAIClient } from "../../lib/ai/vercel-client.js";
import {
  DEFAULT_MODEL,
  INTER_REQUEST_PACING_MS,
  MAX_ATTEMPTS_PER_TURN,
  MAX_OUTPUT_TOKENS_BASE,
  OUTPUT_FRAMING,
  RATE_LIMIT_RETRY_BASE_MS,
  REASONING_EFFORT,
  RESPONSE_SCHEMA,
  RESPONSE_SCHEMA_NAME,
  TIMEOUT_MS,
  WALKER_PROMPT,
} from "../contract.js";
import { normalizeDecisionFields } from "./decision-normalize.js";
import { extractJsonObject } from "./json-extract.js";
import { retryDelay } from "./retry-delay.js";

/**
 * @param {"openai"|"openrouter"} provider
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, model?: string,
 *            retryDelayImpl?: typeof retryDelay, pacingMs?: number,
 *            sleepImpl?: (waitMs: number) => Promise<void> }} [options]
 */
export function createVercelBenchmarkAdapter(provider, apiKey, options = {}) {
  const model = options.model ?? (provider === "openrouter" ? "stealth/ox-alpha" : DEFAULT_MODEL);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const retryDelayImpl = options.retryDelayImpl ?? retryDelay;
  const pacingMs = options.pacingMs ?? INTER_REQUEST_PACING_MS;
  const sleepImpl = options.sleepImpl ?? ((waitMs) => new Promise((resolve) => setTimeout(resolve, waitMs)));
  const client = createEchoMazeAIClient({
    provider,
    apiKey,
    model,
    fetchImpl: options.fetchImpl,
    appName: "Echo Maze Benchmark",
  });

  async function waitForRetry(meta, attempt) {
    if (attempt >= MAX_ATTEMPTS_PER_TURN) return;
    const headers = new Headers(meta?.headers ?? {});
    const retryHint = headers.get("retry-after")
      ?? headers.get("x-ratelimit-reset-tokens")
      ?? headers.get("x-ratelimit-reset-requests")
      ?? null;
    const baseMs = meta?.status === "429" ? RATE_LIMIT_RETRY_BASE_MS : 2_000;
    await retryDelayImpl(retryHint, attempt, baseMs);
  }

  return async function decide(request) {
    const attempts = [];
    let maxOutputTokens = MAX_OUTPUT_TOKENS_BASE;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TURN; attempt += 1) {
      const call = await client.generateStructured({
        instructions: WALKER_PROMPT,
        input: JSON.stringify({
          turn: request.turn,
          currentObservation: request.observation,
          conversation: request.conversation,
        }) + OUTPUT_FRAMING,
        schemaName: RESPONSE_SCHEMA_NAME,
        schema: RESPONSE_SCHEMA,
        maxOutputTokens,
        reasoningEffort: REASONING_EFFORT,
        timeoutMs,
      });

      const meta = call.ok ? call.meta : call.error.meta;
      const rateLimit = extractRateLimitHeaders(new Headers(meta.headers ?? {}));
      const base = {
        attempt,
        latencyMs: meta.latencyMs,
        modelRequested: model,
        responseId: meta.responseId,
        requestId: meta.requestId,
        modelReturned: meta.modelReturned,
        status: meta.status,
        usage: meta.usage,
        rawUsage: meta.rawUsage,
        errorCategory: null,
        rawOutputPreview: null,
        rateLimit,
        providerError: null,
      };

      if (call.ok) {
        const parsed = normalizeDecisionFields(call.data);
        const problem = validateParsed(parsed);
        if (problem) {
          attempts.push({ ...base, errorCategory: problem, rawOutputPreview: preview(call.data) });
          break;
        }
        const pacingDelayMs = computePacingDelayMs(base.usage, rateLimit, pacingMs);
        attempts.push({ ...base, pacingDelayMs });
        if (pacingDelayMs > 0) await sleepImpl(pacingDelayMs);
        return { attempts, parsed, error: null };
      }

      let category = call.error.category;
      let parsed = null;
      if (category === "invalid_structured_json" && call.error.rawOutput) {
        try {
          parsed = normalizeDecisionFields(extractJsonObject(call.error.rawOutput));
          category = validateParsed(parsed) ?? "valid";
        } catch {
          category = "invalid_structured_json";
        }
      }

      if (category === "valid" && parsed) {
        const pacingDelayMs = computePacingDelayMs(base.usage, rateLimit, pacingMs);
        attempts.push({ ...base, pacingDelayMs });
        if (pacingDelayMs > 0) await sleepImpl(pacingDelayMs);
        return { attempts, parsed, error: null };
      }

      attempts.push({
        ...base,
        errorCategory: category,
        rawOutputPreview: call.error.rawOutput?.slice(0, 240) ?? null,
        providerError: sanitizeProviderError(call.error.providerError),
      });

      if (!call.error.retryable) break;
      if (category === "incomplete_output") maxOutputTokens *= 2;
      await waitForRetry(meta, attempt);
    }

    const last = attempts.at(-1);
    const category = last?.errorCategory ?? "unknown";
    const rateLimited = last?.status === "429" || category === "rate_limit_exceeded";
    const invalidCategories = new Set([
      "refusal", "invalid_structured_json", "schema_violation",
      "missing_direction_field", "http_4xx",
    ]);
    return {
      attempts,
      parsed: null,
      error: {
        category: invalidCategories.has(category)
          ? "invalid_response"
          : rateLimited ? "infra_interrupted" : "api_failure",
        message: `Turn failed after ${attempts.length} attempt(s); last category: ${category}.`,
      },
    };
  };
}

export function computePacingDelayMs(usage, rateLimit, minimumMs = INTER_REQUEST_PACING_MS) {
  const inputTokens = Number(usage?.input_tokens);
  const tokenLimit = Number(rateLimit?.limitTokens);
  if (!Number.isFinite(inputTokens) || inputTokens <= 0
    || !Number.isFinite(tokenLimit) || tokenLimit <= 0) {
    return minimumMs;
  }
  const tokenAwareMs = Math.ceil((inputTokens / (tokenLimit * 0.8)) * 60_000);
  return Math.max(minimumMs, tokenAwareMs);
}

export function extractRateLimitHeaders(headers) {
  const values = {
    retryAfter: headers.get("retry-after"),
    limitRequests: headers.get("x-ratelimit-limit-requests"),
    remainingRequests: headers.get("x-ratelimit-remaining-requests"),
    resetRequests: headers.get("x-ratelimit-reset-requests"),
    limitTokens: headers.get("x-ratelimit-limit-tokens"),
    remainingTokens: headers.get("x-ratelimit-remaining-tokens"),
    resetTokens: headers.get("x-ratelimit-reset-tokens"),
  };
  return Object.values(values).some((value) => value !== null) ? values : null;
}

export function sanitizeProviderError(error) {
  if (!error || typeof error !== "object") return null;
  return {
    code: typeof error.code === "string" ? error.code.slice(0, 120) : null,
    type: typeof error.type === "string" ? error.type.slice(0, 120) : null,
    message: typeof error.message === "string" ? error.message.slice(0, 240) : null,
  };
}

export function validateParsed(parsed) {
  return validateSchemaValue(parsed, RESPONSE_SCHEMA) ? null : "schema_violation";
}

function validateSchemaValue(value, schema) {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false
      && Object.keys(value).some((key) => !Object.hasOwn(properties, key))) return false;
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) return false;
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && !validateSchemaValue(value[key], propertySchema)) return false;
    }
    return true;
  }
  if (schema.type === "string") {
    if (typeof value !== "string" || value.trim().length === 0) return false;
    const length = Array.from(value).length;
    return !(typeof schema.minLength === "number" && length < schema.minLength)
      && !(typeof schema.maxLength === "number" && length > schema.maxLength);
  }
  if (schema.type === "integer") {
    return Number.isInteger(value)
      && !(typeof schema.minimum === "number" && value < schema.minimum)
      && !(typeof schema.maximum === "number" && value > schema.maximum);
  }
  return false;
}

function preview(value) {
  try {
    return JSON.stringify(value).slice(0, 240);
  } catch {
    return null;
  }
}
