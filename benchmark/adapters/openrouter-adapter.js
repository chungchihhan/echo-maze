/** OpenRouter Chat Completions transport through the shared Vercel AI SDK client. */

import { createVercelBenchmarkAdapter } from "./vercel-adapter.js";

export function createOpenRouterAdapter(apiKey, options = {}) {
  return createVercelBenchmarkAdapter("openrouter", apiKey, options);
}

/** Normalize provider-native usage into the benchmark metric shape. */
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
