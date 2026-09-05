/** OpenAI Responses transport through the shared Vercel AI SDK client. */

import { createVercelBenchmarkAdapter } from "./vercel-adapter.js";

export {
  computePacingDelayMs,
  extractRateLimitHeaders,
  sanitizeProviderError,
  validateParsed,
} from "./vercel-adapter.js";

export function createOpenAIAdapter(apiKey, options = {}) {
  return createVercelBenchmarkAdapter("openai", apiKey, options);
}

/** Retained for forensic payload tests and archived artifact tooling. */
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
