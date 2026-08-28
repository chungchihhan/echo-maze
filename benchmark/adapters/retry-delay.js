/**
 * Shared transport retry backoff.
 *
 * Retry-After may be either a number of seconds or an HTTP date. When it is
 * absent, use bounded exponential backoff. The delay starts after the failed
 * response is received; request latency is intentionally not subtracted from
 * it because Retry-After is a response-relative wait instruction.
 */

/**
 * @param {string | null} retryAfterHeader
 * @param {number} attempt
 * @param {number} [baseMs]
 * @param {number} [nowMs]
 */
export function computeRetryDelayMs(retryAfterHeader, attempt, baseMs = 2000, nowMs = Date.now()) {
  const seconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const retryAt = retryAfterHeader ? Date.parse(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAt)) return Math.max(0, retryAt - nowMs);

  return Math.min(120_000, baseMs * 2 ** (attempt - 1));
}

/**
 * @param {string | null} retryAfterHeader
 * @param {number} attempt
 * @param {number} [baseMs]
 * @param {(waitMs: number) => Promise<void>} [sleepImpl]
 */
export async function retryDelay(
  retryAfterHeader,
  attempt,
  baseMs = 2000,
  sleepImpl = (waitMs) => new Promise((resolve) => setTimeout(resolve, waitMs)),
) {
  const waitMs = computeRetryDelayMs(retryAfterHeader, attempt, baseMs);
  await sleepImpl(waitMs);
}
