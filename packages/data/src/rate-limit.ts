/**
 * Rate limiting and retry.
 *
 * Sized around a hard-won fact about the free providers: Yahoo publishes no
 * rate limits at all, enforces them per IP, and a ban lasts anywhere from an
 * hour to a day. There is no Retry-After to obey and no quota to budget
 * against, so the only safe posture is to stay conservatively slow and back off
 * hard at the first sign of throttling.
 *
 * Both the clock and the sleep function are injectable, so backoff behaviour is
 * tested deterministically rather than by actually waiting.
 */

import { RateLimitedError, isProviderError } from './errors';
import type { Clock } from './cache';

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface RateLimiterOptions {
  /** Sustained requests permitted per interval. */
  readonly requestsPerInterval: number;
  /** Interval length in milliseconds. */
  readonly intervalMs: number;
  /**
   * Burst allowance. Defaults to `requestsPerInterval`. Keep this low for
   * undocumented endpoints - a burst is exactly what trips per-IP throttling.
   */
  readonly burst?: number;
  readonly clock?: Clock;
  readonly sleep?: Sleep;
}

/**
 * Token-bucket rate limiter.
 *
 * Tokens refill continuously rather than in discrete windows, which avoids the
 * thundering herd at each window boundary that a fixed-window limiter creates.
 */
export class RateLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #clock: Clock;
  readonly #sleep: Sleep;

  #tokens: number;
  #lastRefill: number;
  /** Serialises waiters so they acquire in call order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    const { requestsPerInterval, intervalMs } = options;
    if (!(requestsPerInterval > 0)) {
      throw new RangeError('requestsPerInterval must be positive');
    }
    if (!(intervalMs > 0)) {
      throw new RangeError('intervalMs must be positive');
    }

    this.#capacity = options.burst ?? requestsPerInterval;
    this.#refillPerMs = requestsPerInterval / intervalMs;
    this.#clock = options.clock ?? Date.now;
    this.#sleep = options.sleep ?? realSleep;
    this.#tokens = this.#capacity;
    this.#lastRefill = this.#clock();
  }

  #refill(): void {
    const now = this.#clock();
    const elapsed = now - this.#lastRefill;
    if (elapsed <= 0) return;
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + elapsed * this.#refillPerMs,
    );
    this.#lastRefill = now;
  }

  /** Milliseconds until a token is available, 0 if one is available now. */
  msUntilAvailable(): number {
    this.#refill();
    if (this.#tokens >= 1) return 0;
    return Math.ceil((1 - this.#tokens) / this.#refillPerMs);
  }

  /**
   * Waits until a token is available, then consumes it. Calls are served in
   * order, so a burst of concurrent requests is paced rather than racing.
   */
  async acquire(): Promise<void> {
    const run = this.#queue.then(async () => {
      for (;;) {
        this.#refill();
        if (this.#tokens >= 1) {
          this.#tokens -= 1;
          return;
        }
        const waitMs = Math.max(
          1,
          Math.ceil((1 - this.#tokens) / this.#refillPerMs),
        );
        await this.#sleep(waitMs);
      }
    });

    // Keep the chain alive even if a waiter rejects.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Currently available tokens, for observability. */
  get availableTokens(): number {
    this.#refill();
    return this.#tokens;
  }
}

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: Sleep;
  /** Deterministic jitter source in [0, 1). Defaults to Math.random. */
  readonly random?: () => number;
  /** Invoked before each retry, for logging. */
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Retries an operation with exponential backoff and full jitter.
 *
 * Only retries errors the taxonomy marks retryable, so a `MissingDataError` for
 * a ticker with no listed options fails immediately instead of burning three
 * attempts - across a 500-name universe that distinction is the difference
 * between a scan finishing and a scan getting throttled.
 *
 * A `RateLimitedError` carrying `retryAfterMs` overrides the computed backoff.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const retryable = isProviderError(error) && error.retryable;
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }

      const exponential = Math.min(
        maxDelayMs,
        baseDelayMs * 2 ** (attempt - 1),
      );
      // Full jitter: sleep uniformly in [0, exponential]. Decorrelates
      // concurrent workers far better than fixed or equal jitter.
      let delayMs = Math.floor(random() * exponential);

      if (error instanceof RateLimitedError && error.retryAfterMs !== undefined) {
        delayMs = Math.min(error.retryAfterMs, maxDelayMs);
      }

      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Conservative default pacing for Yahoo's undocumented endpoints.
 *
 * Community reports converge on roughly 100 requests followed by a pause;
 * others hit throttling after several hundred. One request per second sustained
 * sits comfortably below every reported threshold, and since options chains are
 * cached for 15 minutes the pacing costs little in practice.
 */
export const YAHOO_RATE_LIMIT: RateLimiterOptions = {
  requestsPerInterval: 1,
  intervalMs: 1_000,
  burst: 3,
};

/**
 * Alpaca publishes 200 requests/minute on the free Basic plan. We deliberately
 * run below the documented ceiling to leave headroom for other callers sharing
 * the key.
 */
export const ALPACA_RATE_LIMIT: RateLimiterOptions = {
  requestsPerInterval: 150,
  intervalMs: 60_000,
  burst: 20,
};
