/**
 * OpenAI Responses API adapter for the Echo Maze benchmark.
 *
 * Contract:
 * - Transport failures (timeout, network, HTTP 408/409/429/5xx, unreadable
 *   body on 5xx, incomplete/missing output) are retried up to the contract's
 *   attempt budget; every attempt is recorded.
 * - Invalid model output (unparseable JSON, schema violation, refusal) is
 *   recorded and NOT retried or repaired.
 * - The API key is read from the environment and never logged or returned.
 */

import {
  DEFAULT_MODEL,
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
import { retryDelay } from "./retry-delay.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

/** @typedef {{ attempt: number, latencyMs: number, modelRequested: string, responseId: string | null, requestId: string | null, modelReturned: string | null, status: string | null, usage: Record<string, unknown> | null, errorCategory: string | null, rawOutputPreview: string | null }} AttemptRecord */

/**
 * @typedef {{
 *   attempts: AttemptRecord[],
 *   parsed: Record<string, unknown> | null,
 *   error: { category: "api_failure"|"invalid_response", message: string } | null,
 * }} AdapterResult
 */

/**
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, model?: string,
 *            retryDelayImpl?: typeof retryDelay }} [options]
 */
export function createOpenAIAdapter(apiKey, options = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for live benchmark runs.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const model = options.model ?? DEFAULT_MODEL;
  const retryDelayImpl = options.retryDelayImpl ?? retryDelay;

  async function waitForRetry(response, attempt) {
    if (attempt >= MAX_ATTEMPTS_PER_TURN) return;
    const retryAfter = response?.headers?.get("retry-after") ?? null;
    const baseMs = response?.status === 429 ? 20_000 : 2_000;
    await retryDelayImpl(retryAfter, attempt, baseMs);
  }

  /**
   * @param {{ turn: number, observation: unknown, conversation: unknown[] }} request
   * @returns {Promise<AdapterResult>}
   */
  return async function decide(request) {
    /** @type {AttemptRecord[]} */
    const attempts = [];
    let maxOutputTokens = MAX_OUTPUT_TOKENS_BASE;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_TURN; attempt += 1) {
      const startedAt = Date.now();
      /** @type {Response | undefined} */
      let response;
      try {
        response = await fetchImpl(RESPONSES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            instructions: WALKER_PROMPT,
            input: JSON.stringify({
              turn: request.turn,
              currentObservation: request.observation,
              conversation: request.conversation,
            }) + OUTPUT_FRAMING,
            reasoning: { effort: REASONING_EFFORT },
            max_output_tokens: maxOutputTokens,
            store: false,
            text: {
              verbosity: "low",
              format: {
                type: "json_schema",
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
          attempt, latencyMs: Date.now() - startedAt, modelRequested: model,
          responseId: null, requestId: null,
          modelReturned: null, status: null, usage: null,
          errorCategory: timedOut ? "timeout" : "network_error",
          rawOutputPreview: null,
        });
        await waitForRetry(response, attempt);
        continue; // retryable transport failure
      }

      const requestId = response.headers.get("x-request-id");
      /** @type {any} */
      let body;
      try {
        body = await response.json();
      } catch {
        const retryable = response.status >= 500;
        attempts.push({
          attempt, latencyMs: Date.now() - startedAt, modelRequested: model,
          responseId: null, requestId,
          modelReturned: null, status: String(response.status), usage: null,
          errorCategory: "invalid_api_response", rawOutputPreview: null,
        });
        if (!retryable) break; // non-retryable
        await waitForRetry(response, attempt);
        continue;
      }

      const base = {
        attempt,
        latencyMs: Date.now() - startedAt,
        modelRequested: model,
        responseId: body.id ?? null,
        requestId,
        modelReturned: body.model ?? null,
        status: body.status ?? String(response.status),
        usage: body.usage ?? null,
        errorCategory: null,
        rawOutputPreview: null,
      };

      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 409
          || response.status === 429 || response.status >= 500;
        attempts.push({
          ...base,
          errorCategory: body.error?.code ?? `http_${response.status}`,
        });
        if (retryable) {
          await waitForRetry(response, attempt);
          continue;
        }
        break;
      }

      if (body.status === "incomplete") {
        attempts.push({ ...base, errorCategory: "incomplete_output" });
        maxOutputTokens *= 2;
        await waitForRetry(response, attempt);
        continue; // retryable with a larger budget
      }

      const output = extractOutputText(body);
      if (output.refusal) {
        attempts.push({ ...base, errorCategory: "refusal", rawOutputPreview: output.refusal.slice(0, 240) });
        break; // invalid model output: never repaired
      }
      if (!output.text) {
        attempts.push({ ...base, errorCategory: "missing_output_text" });
        await waitForRetry(response, attempt);
        continue; // retryable transport-shaped failure
      }

      try {
        const parsed = normalizeDecisionFields(extractJsonObject(output.text));
        const problem = validateParsed(parsed);
        if (problem) {
          attempts.push({ ...base, errorCategory: problem, rawOutputPreview: output.text.slice(0, 240) });
          break; // invalid model output: never repaired
        }
        attempts.push(base);
        return { attempts, parsed, error: null };
      } catch {
        attempts.push({
          ...base,
          errorCategory: "invalid_structured_json",
          rawOutputPreview: output.text.slice(0, 240),
        });
        break; // invalid model output: never repaired
      }
    }

    const last = attempts[attempts.length - 1];
    const category = last?.errorCategory ?? "unknown";
    const invalidCategories = new Set([
      "refusal", "invalid_structured_json", "schema_violation",
      "missing_direction_field", "http_4xx",
    ]);
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
 * Extract output text or refusal from a Responses API payload.
 *
 * @param {any} body
 * @returns {{ text: string | null, refusal: string | null }}
 */
export function extractOutputText(body) {
  if (body.output_text) return { text: body.output_text, refusal: null };
  let refusal = null;
  for (const item of body.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) return { text: content.text, refusal: null };
      if (content.type === "refusal" && content.refusal) refusal = content.refusal;
    }
  }
  return { text: null, refusal };
}

/**
 * Validate the parsed decision against the same JSON-schema object sent to
 * the provider. This intentionally covers the schema subset used by the
 * contract: objects, required keys, additionalProperties, strings with
 * length bounds, integers with numeric bounds, and enums.
 *
 * @param {unknown} parsed
 * @returns {string | null}
 */
export function validateParsed(parsed) {
  return validateSchemaValue(parsed, RESPONSE_SCHEMA) ? null : "schema_violation";
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} schema
 * @returns {boolean}
 */
function validateSchemaValue(value, schema) {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;

  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const objectValue = /** @type {Record<string, unknown>} */ (value);
    const properties = /** @type {Record<string, Record<string, unknown>>} */ (schema.properties ?? {});

    if (schema.additionalProperties === false
      && Object.keys(objectValue).some((key) => !Object.hasOwn(properties, key))) {
      return false;
    }
    for (const required of /** @type {string[]} */ (schema.required ?? [])) {
      if (!Object.hasOwn(objectValue, required)) return false;
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(objectValue, key) && !validateSchemaValue(objectValue[key], propertySchema)) {
        return false;
      }
    }
    return true;
  }

  if (schema.type === "string") {
    if (typeof value !== "string" || value.trim().length === 0) return false;
    const length = Array.from(value).length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
    return true;
  }

  if (schema.type === "integer") {
    if (!Number.isInteger(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    return true;
  }

  return false;
}
