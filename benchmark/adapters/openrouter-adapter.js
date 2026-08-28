/**
 * OpenRouter adapter for the Echo Maze benchmark (chat/completions API).
 *
 * Same contract as the OpenAI Responses adapter:
 * - Transport failures (timeout, network, HTTP 408/409/429/5xx, unreadable
 *   body on 5xx, missing output) are retried within the attempt budget and
 *   every attempt is recorded.
 * - Invalid model output (unparseable JSON, schema violation, refusal) is
 *   recorded and NOT retried or repaired.
 * - The API key is read from the environment and never logged or returned.
 *
 * Usage payloads are normalized to the Responses-style shape so the metrics
 * pipeline works unchanged; the raw provider usage is preserved alongside.
 */

import {
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
import { extractJsonObject } from "./json-extract.js";
import { normalizeDecisionFields } from "./decision-normalize.js";
import {
  computePacingDelayMs,
  extractRateLimitHeaders,
  sanitizeProviderError,
  validateParsed,
} from "./openai-adapter.js";
import { retryDelay } from "./retry-delay.js";
const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, model?: string,
 *            retryDelayImpl?: typeof retryDelay }} [options]
 */
export function createOpenRouterAdapter(apiKey, options = {}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for live benchmark runs.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const model = options.model ?? "stealth/ox-alpha";
  const retryDelayImpl = options.retryDelayImpl ?? retryDelay;
  // Inter-request pacing keeps steady turn loops under provider rate limits.
  const pacingMs = options.pacingMs ?? INTER_REQUEST_PACING_MS;

  async function waitForRetry(response, attempt, baseMs = 2000) {
    if (attempt >= MAX_ATTEMPTS_PER_TURN) return;
    const retryHint = response?.headers?.get("retry-after")
      ?? response?.headers?.get("x-ratelimit-reset-tokens")
      ?? response?.headers?.get("x-ratelimit-reset-requests")
      ?? null;
    await retryDelayImpl(retryHint, attempt, baseMs);
  }

  /**
   * @param {{ turn: number, observation: unknown, conversation: unknown[] }} request
   * @returns {Promise<{ attempts: any[], parsed: Record<string, unknown> | null,
   *                     error: { category: string, message: string } | null }>}
   */
  return async function decide(request) {
    /** @type {any[]} */
    const attempts = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TURN; attempt += 1) {
      const startedAt = Date.now();
      /** @type {Response | undefined} */
      let response;
      try {
        response = await fetchImpl(CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Title": "Echo Maze Benchmark",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: WALKER_PROMPT },
              {
                role: "user",
                content: JSON.stringify({
                  turn: request.turn,
                  currentObservation: request.observation,
                  conversation: request.conversation,
                }) + OUTPUT_FRAMING,
              },
            ],
            reasoning: { effort: REASONING_EFFORT },
            max_tokens: MAX_OUTPUT_TOKENS_BASE * attempt,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: RESPONSE_SCHEMA_NAME,
                strict: true,
                schema: RESPONSE_SCHEMA,
              },
            },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        attempts.push({
          attempt, latencyMs: Date.now() - startedAt, responseId: null, requestId: null,
          modelRequested: model, modelReturned: null, status: null, usage: null, rawUsage: null,
          errorCategory: timedOut ? "timeout" : "network_error", rawOutputPreview: null,
        });
        await waitForRetry(response, attempt);
        continue;
      }

      const requestId = response.headers.get("x-request-id");
      const rateLimit = extractRateLimitHeaders(response.headers);
      /** @type {any} */
      let body;
      try {
        body = await response.json();
      } catch {
        const retryable = response.status === 408 || response.status === 409
          || response.status === 429 || response.status >= 500;
        attempts.push({
          attempt, latencyMs: Date.now() - startedAt, responseId: null, requestId,
          modelRequested: model, modelReturned: null, status: String(response.status), usage: null, rawUsage: null,
          errorCategory: "invalid_api_response", rawOutputPreview: null,
          rateLimit, providerError: null,
        });
        if (!retryable) break;
        await waitForRetry(response, attempt, response.status === 429 ? RATE_LIMIT_RETRY_BASE_MS : 2_000);
        continue;
      }

      const base = {
        attempt,
        latencyMs: Date.now() - startedAt,
        modelRequested: model,
        responseId: body.id ?? null,
        requestId,
        modelReturned: body.model ?? null,
        status: String(response.status),
        usage: normalizeUsage(body.usage),
        rawUsage: body.usage ?? null,
        errorCategory: null,
        rawOutputPreview: null,
        rateLimit,
        providerError: null,
      };

      if (!response.ok || body.error) {
        const retryable = response.status === 408 || response.status === 409
          || response.status === 429 || response.status >= 500;
        attempts.push({
          ...base,
          errorCategory: body.error?.code ?? body.error?.metadata?.raw
            ?? `http_${response.status}`,
          providerError: sanitizeProviderError(body.error),
        });
        if (retryable) {
          await waitForRetry(response, attempt, response.status === 429 ? RATE_LIMIT_RETRY_BASE_MS : 2_000);
          continue;
        }
        break;
      }

      const choice = (body.choices ?? [])[0];
      const message = choice?.message ?? {};
      // A response cut off by the token budget is a budget event, not invalid
      // output: retry once with the doubled budget before giving up.
      if (!message.refusal && choice?.finish_reason === "length") {
        attempts.push({ ...base, errorCategory: "incomplete_output" });
        await waitForRetry(response, attempt);
        continue;
      }
      if (message.refusal) {
        attempts.push({
          ...base,
          errorCategory: "refusal",
          rawOutputPreview: String(message.refusal).slice(0, 240),
        });
        break; // invalid model output: never repaired
      }

      const text = typeof message.content === "string" ? message.content : null;
      if (!text) {
        attempts.push({ ...base, errorCategory: "missing_output_text" });
        await waitForRetry(response, attempt);
        continue; // retryable transport-shaped failure
      }

      try {
        const parsed = normalizeDecisionFields(extractJsonObject(text));
        const problem = validateParsed(parsed);
        if (problem) {
          attempts.push({ ...base, errorCategory: problem, rawOutputPreview: text.slice(0, 240) });
          break; // invalid model output: never repaired
        }
        const pacingDelayMs = computePacingDelayMs(base.usage, rateLimit, pacingMs);
        attempts.push({ ...base, pacingDelayMs });
        if (pacingDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, pacingDelayMs));
        return { attempts, parsed, error: null };
      } catch {
        attempts.push({
          ...base,
          errorCategory: "invalid_structured_json",
          rawOutputPreview: text.slice(0, 240),
        });
        break; // invalid model output: never repaired
      }
    }

    const last = attempts[attempts.length - 1];
    const category = last?.errorCategory ?? "unknown";
    const rateLimited = last?.status === "429" || category === "rate_limit_exceeded";
    const invalidCategories = new Set(["refusal", "invalid_structured_json", "schema_violation"]);
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

/**
 * Normalize chat/completions usage into the Responses-style shape consumed by
 * the metrics pipeline. The original payload is preserved by the caller as
 * `rawUsage`.
 *
 * @param {any} usage
 */
export function normalizeUsage(usage) {
  if (!usage) return null;
  const details = usage.completion_tokens_details ?? usage.output_tokens_details ?? {};
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
    output_tokens_details: { reasoning_tokens: details.reasoning_tokens ?? 0 },
  };
}
