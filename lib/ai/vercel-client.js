import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { NoObjectGeneratedError, NoOutputGeneratedError, Output, generateText, jsonSchema } from "ai";

/** @typedef {"openai"|"openrouter"} EchoMazeProvider */

/**
 * One provider request through the Vercel AI SDK. This layer deliberately
 * disables SDK retries: callers own retry policy, pacing, and attempt logs.
 *
 * @param {{
 *   provider: EchoMazeProvider,
 *   apiKey: string,
 *   model: string,
 *   fetchImpl?: typeof fetch,
 *   appName?: string,
 * }} config
 */
export function createEchoMazeAIClient(config) {
  if (!config.apiKey) throw new Error(`${providerKeyName(config.provider)} is required.`);

  const providerModel = createProviderModel(config);

  return {
    /**
     * @param {{
     *   instructions: string,
     *   input: string,
     *   schemaName: string,
     *   schema: Record<string, unknown>,
     *   maxOutputTokens: number,
     *   reasoningEffort?: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max",
     *   timeoutMs: number,
     * }} request
     */
    async generateStructured(request) {
      const startedAt = Date.now();
      try {
        const result = await generateText({
          model: providerModel,
          ...(config.provider === "openai"
            ? {}
            : { instructions: request.instructions }),
          prompt: request.input,
          output: Output.object({
            name: request.schemaName,
            schema: jsonSchema(request.schema),
          }),
          maxOutputTokens: request.maxOutputTokens,
          maxRetries: 0,
          timeout: request.timeoutMs,
          include: { responseBody: true },
          providerOptions: providerOptions(config.provider, request),
        });

        const meta = resultMetadata(config, result, startedAt);
        const refusal = extractRefusal(meta.responseBody);
        if (refusal) {
          return failure(meta, {
            category: "refusal",
            message: refusal,
            retryable: false,
            rawOutput: refusal,
          });
        }

        try {
          return { ok: true, data: result.output, meta };
        } catch (error) {
          if (NoObjectGeneratedError.isInstance(error)) {
            const category = error.finishReason === "length" ? "incomplete_output" : "invalid_structured_json";
            return failure(meta, {
              category,
              message: error.message,
              retryable: category === "incomplete_output",
              rawOutput: error.text ?? extractOutputText(meta.responseBody),
            });
          }
          if (NoOutputGeneratedError.isInstance(error)) {
            const category = meta.finishReason === "length" || meta.status === "incomplete"
              ? "incomplete_output"
              : "missing_output_text";
            return failure(meta, {
              category,
              message: error.message,
              retryable: true,
              rawOutput: extractOutputText(meta.responseBody),
            });
          }
          throw error;
        }
      } catch (error) {
        return failureFromThrown(config, error, startedAt);
      }
    },
  };
}

function createProviderModel(config) {
  if (config.provider === "openai") {
    return createOpenAI({ apiKey: config.apiKey, fetch: config.fetchImpl }).responses(config.model);
  }
  if (config.provider === "openrouter") {
    return createOpenRouter({
      apiKey: config.apiKey,
      fetch: config.fetchImpl,
      compatibility: "strict",
      appName: config.appName ?? "Echo Maze",
    }).chat(config.model);
  }
  throw new Error(`Unsupported AI provider: ${config.provider}`);
}

function providerOptions(provider, request) {
  const reasoningEffort = request.reasoningEffort ?? "low";
  if (provider === "openai") {
    return {
      openai: {
        instructions: request.instructions,
        reasoningEffort,
        reasoningSummary: null,
        store: false,
        strictJsonSchema: true,
        textVerbosity: "low",
      },
    };
  }
  return {
    openrouter: {
      reasoning: { effort: reasoningEffort },
      usage: { include: true },
    },
  };
}

function resultMetadata(config, result, startedAt) {
  const responseBody = asRecord(result.response.body);
  const headers = result.response.headers ?? {};
  const rawUsage = asRecord(responseBody?.usage) ?? null;
  return {
    provider: config.provider,
    modelRequested: config.model,
    modelReturned: typeof responseBody?.model === "string" ? responseBody.model : result.response.modelId ?? null,
    responseId: typeof responseBody?.id === "string" ? responseBody.id : result.response.id ?? null,
    requestId: headerValue(headers, "x-request-id"),
    status: typeof responseBody?.status === "string" ? responseBody.status : "200",
    headers,
    usage: normalizeUsage(result.usage),
    rawUsage,
    responseBody,
    providerMetadata: result.providerMetadata ?? null,
    finishReason: result.finishReason,
    latencyMs: Date.now() - startedAt,
  };
}

function failure(meta, error) {
  return { ok: false, error: { ...error, meta } };
}

function failureFromThrown(config, error, startedAt) {
  if (NoObjectGeneratedError.isInstance(error)) {
    const meta = outputErrorMetadata(config, error, startedAt);
    const category = error.finishReason === "length" ? "incomplete_output" : "invalid_structured_json";
    return failure(meta, {
      category,
      message: error.message,
      retryable: category === "incomplete_output",
      rawOutput: error.text ?? null,
      providerError: null,
    });
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    const meta = outputErrorMetadata(config, error, startedAt);
    return failure(meta, {
      category: "missing_output_text",
      message: error.message,
      retryable: true,
      rawOutput: null,
      providerError: null,
    });
  }
  const source = findApiError(error);
  const statusCode = numberOrNull(source?.statusCode);
  const headers = asHeaderRecord(source?.responseHeaders);
  const responseBody = parseResponseBody(source?.responseBody) ?? asRecord(source?.data);
  const providerError = asRecord(responseBody?.error) ?? asRecord(responseBody);
  const timedOut = errorChainHasName(error, new Set(["TimeoutError", "AbortError"]));
  const category = timedOut
    ? "timeout"
    : statusCode !== null
      ? providerErrorCode(providerError) ?? `http_${statusCode}`
      : "network_error";
  const retryable = timedOut || Boolean(source?.isRetryable)
    || statusCode === 408 || statusCode === 409 || statusCode === 429
    || (statusCode !== null && statusCode >= 500);
  const meta = {
    provider: config.provider,
    modelRequested: config.model,
    modelReturned: typeof responseBody?.model === "string" ? responseBody.model : null,
    responseId: typeof responseBody?.id === "string" ? responseBody.id : null,
    requestId: headerValue(headers, "x-request-id"),
    status: statusCode === null ? null : String(statusCode),
    headers,
    usage: null,
    rawUsage: asRecord(responseBody?.usage) ?? null,
    responseBody,
    providerMetadata: null,
    finishReason: null,
    latencyMs: Date.now() - startedAt,
  };
  return failure(meta, {
    category,
    message: error instanceof Error ? error.message : "AI provider request failed.",
    retryable,
    rawOutput: null,
    providerError,
  });
}

function outputErrorMetadata(config, error, startedAt) {
  const response = error.response ?? {};
  return {
    provider: config.provider,
    modelRequested: config.model,
    modelReturned: response.modelId ?? null,
    responseId: response.id ?? null,
    requestId: headerValue(response.headers ?? {}, "x-request-id"),
    status: "200",
    headers: response.headers ?? {},
    usage: normalizeUsage(error.usage),
    rawUsage: null,
    responseBody: null,
    providerMetadata: null,
    finishReason: error.finishReason ?? null,
    latencyMs: Date.now() - startedAt,
  };
}

function findApiError(error) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if ("statusCode" in current || "responseHeaders" in current || "responseBody" in current) return current;
    current = current.cause;
  }
  return null;
}

function errorChainHasName(error, names) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    if (typeof current.name === "string" && names.has(current.name)) return true;
    current = current.cause;
  }
  return false;
}

function normalizeUsage(usage) {
  if (!usage) return null;
  const inputTokens = numberOrZero(usage.inputTokens);
  const outputTokens = numberOrZero(usage.outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberOrZero(usage.totalTokens) || inputTokens + outputTokens,
    output_tokens_details: {
      reasoning_tokens: numberOrZero(usage.outputTokenDetails?.reasoningTokens),
    },
  };
}

function extractOutputText(body) {
  if (!body) return null;
  if (typeof body.output_text === "string") return body.output_text;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choiceText = choices[0]?.message?.content;
  if (typeof choiceText === "string") return choiceText;
  for (const item of Array.isArray(body.output) ? body.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function extractRefusal(body) {
  if (!body) return null;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choiceRefusal = choices[0]?.message?.refusal;
  if (typeof choiceRefusal === "string" && choiceRefusal) return choiceRefusal;
  for (const item of Array.isArray(body.output) ? body.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "refusal" && typeof content.refusal === "string") return content.refusal;
    }
  }
  return null;
}

function providerErrorCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function parseResponseBody(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asHeaderRecord(value) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string"));
}

function headerValue(headers, name) {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === expected && typeof value === "string") return value;
  }
  return null;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function providerKeyName(provider) {
  return provider === "openrouter" ? "OPENROUTER_API_KEY" : "OPENAI_API_KEY";
}
