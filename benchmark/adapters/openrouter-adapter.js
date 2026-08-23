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
  MAX_ATTEMPTS_PER_TURN,
  MAX_OUTPUT_TOKENS_BASE,
  OUTPUT_FRAMING,
  REASONING_EFFORT,
  RESPONSE_SCHEMA,
  RESPONSE_SCHEMA_NAME,
  TIMEOUT_MS,
  WALKER_PROMPT,
} from "../contract.js";
import { extractJsonObject } from "./json-extract.js";
import { normalizeDecisionFields } from "./decision-normalize.js";
const CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Backoff before a retry: honors Retry-After (seconds) else exponential. */
async function retryDelay(retryAfterHeader, attempt, latencyMs = 0, baseMs = 2000) {
  const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const waitMs = Number.isFinite(parsed)
    ? parsed * 1000
    : Math.min(120_000, baseMs * 2 ** (attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, waitMs - latencyMs)));
}

/**
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, model?: string }} [options]
 */
export function createOpenRouterAdapter(apiKey, options = {}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required for live benchmark runs.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const model = options.model ?? "stealth/ox-alpha";
  // Inter-request pacing keeps steady turn loops under provider rate limits.
  const pacingMs = options.pacingMs ?? 2500;

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
          modelReturned: null, status: null, usage: null, rawUsage: null,
          errorCategory: timedOut ? "timeout" : "network_error", rawOutputPreview: null,
        });
        await retryDelay(response?.headers?.get("retry-after"), attempt);
        continue;
      }

      const requestId = response.headers.get("x-request-id");
      /** @type {any} */
      let body;
      try {
        body = await response.json();
      } catch {
        const retryable = response.status >= 500;
        attempts.push({
          attempt, latencyMs: Date.now() - startedAt, responseId: null, requestId,
          modelReturned: null, status: String(response.status), usage: null, rawUsage: null,
          errorCategory: "invalid_api_response", rawOutputPreview: null,
        });
        if (!retryable) break;
        await retryDelay(response.headers.get("retry-after"), attempt, 0, response.status === 429 ? 20_000 : 2_000);
        continue;
      }

      const base = {
        attempt,
        latencyMs: Date.now() - startedAt,
        responseId: body.id ?? null,
        requestId,
        modelReturned: body.model ?? null,
        status: body.error ? "error" : String(response.status),
        usage: normalizeUsage(body.usage),
        rawUsage: body.usage ?? null,
        errorCategory: null,
        rawOutputPreview: null,
      };

      if (!response.ok || body.error) {
        const retryable = response.status === 408 || response.status === 409
          || response.status === 429 || response.status >= 500;
        attempts.push({
          ...base,
          errorCategory: body.error?.code ?? body.error?.metadata?.raw
            ?? `http_${response.status}`,
        });
        if (retryable) {
          await retryDelay(response.headers.get("retry-after"), attempt, base.latencyMs, response.status === 429 ? 20_000 : 2_000);
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
        await retryDelay(response.headers.get("retry-after"), attempt);
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
        await retryDelay(response.headers.get("retry-after"), attempt);
        continue; // retryable transport-shaped failure
      }

      try {
        const parsed = normalizeDecisionFields(extractJsonObject(text));
        // Reuse the shared structural validation from the OpenAI adapter.
        const { validateParsed } = await import("./openai-adapter.js");
        const problem = validateParsed(parsed);
        if (problem) {
          attempts.push({ ...base, errorCategory: problem, rawOutputPreview: text.slice(0, 240) });
          break; // invalid model output: never repaired
        }
        attempts.push(base);
        if (pacingMs > 0) await new Promise((resolve) => setTimeout(resolve, pacingMs));
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
    const invalidCategories = new Set(["refusal", "invalid_structured_json", "schema_violation"]);
    return {
      attempts,
      parsed: null,
      error: {
        category: invalidCategories.has(category) ? "invalid_response" : "api_failure",
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
