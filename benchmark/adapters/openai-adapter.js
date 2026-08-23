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
  MODEL_ALLOWLIST,
  OUTPUT_FRAMING,
  REASONING_EFFORT,
  RESPONSE_SCHEMA,
  RESPONSE_SCHEMA_NAME,
  TIMEOUT_MS,
  WALKER_PROMPT,
} from "../contract.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

/** @typedef {{ attempt: number, latencyMs: number, responseId: string | null, requestId: string | null, modelReturned: string | null, status: string | null, usage: Record<string, unknown> | null, errorCategory: string | null, rawOutputPreview: string | null }} AttemptRecord */

/**
 * @typedef {{
 *   attempts: AttemptRecord[],
 *   parsed: Record<string, unknown> | null,
 *   error: { category: "api_failure"|"invalid_response", message: string } | null,
 * }} AdapterResult
 */

/**
 * @param {string} apiKey
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export function createOpenAIAdapter(apiKey, options = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for live benchmark runs.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

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
            model: DEFAULT_MODEL,
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
          attempt, latencyMs: Date.now() - startedAt, responseId: null, requestId: null,
          modelReturned: null, status: null, usage: null,
          errorCategory: timedOut ? "timeout" : "network_error",
          rawOutputPreview: null,
        });
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
          attempt, latencyMs: Date.now() - startedAt, responseId: null, requestId,
          modelReturned: null, status: String(response.status), usage: null,
          errorCategory: "invalid_api_response", rawOutputPreview: null,
        });
        if (!retryable) break; // non-retryable
        continue;
      }

      const base = {
        attempt,
        latencyMs: Date.now() - startedAt,
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
        if (retryable) continue;
        break;
      }

      if (body.status === "incomplete") {
        attempts.push({ ...base, errorCategory: "incomplete_output" });
        continue; // retryable with a larger budget
      }

      const output = extractOutputText(body);
      if (output.refusal) {
        attempts.push({ ...base, errorCategory: "refusal", rawOutputPreview: output.refusal.slice(0, 240) });
        break; // invalid model output: never repaired
      }
      if (!output.text) {
        attempts.push({ ...base, errorCategory: "missing_output_text" });
        continue; // retryable transport-shaped failure
      }

      try {
        const parsed = JSON.parse(output.text);
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
 * Structural validation of the parsed decision (mirrors the UI route).
 * Returns an error category string when invalid, else null.
 *
 * @param {unknown} parsed
 * @returns {string | null}
 */
export function validateParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return "invalid_structured_json";
  const value = /** @type {Record<string, unknown>} */ (parsed);
  const summary = value.observation_summary;
  const reasoning = value.reasoning_summary;
  const note = value.coordinate_note;
  const believed = value.believed_position;
  if (typeof summary !== "string" || summary.trim().length === 0) return "schema_violation";
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) return "schema_violation";
  if (typeof note !== "string" || note.trim().length === 0) return "schema_violation";
  if (!believed || typeof believed !== "object") return "schema_violation";
  const point = /** @type {Record<string, unknown>} */ (believed);
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) return "schema_violation";
  if (!MODEL_ALLOWLIST.length) return "schema_violation"; // unreachable guard
  if (value.direction !== "up" && value.direction !== "right"
    && value.direction !== "down" && value.direction !== "left") {
    return "schema_violation";
  }
  return null;
}
