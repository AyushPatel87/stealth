/**
 * Provider error taxonomy.
 *
 * The distinctions here are not cosmetic - each one drives a different product
 * behaviour, which is why they are separate types rather than one error with a
 * message string:
 *
 *   RateLimited        back off and retry; the data is fine, we asked too fast
 *   ProviderUnavailable retry later, possibly failing over to another provider
 *   MissingData        do NOT retry; this symbol genuinely has no such data
 *   InvalidResponse    do NOT retry blindly; the provider's schema has drifted
 *   StaleData          serve the cached value, but label it in the UI
 *
 * Conflating "no options chain exists for this ticker" with "the provider is
 * down" would either hammer a rate-limited API with pointless retries or
 * silently drop half the universe from a scan.
 */

export type ProviderErrorKind =
  | 'rate-limited'
  | 'provider-unavailable'
  | 'missing-data'
  | 'invalid-response'
  | 'stale-data'
  | 'not-supported';

export interface ProviderErrorContext {
  readonly provider: string;
  readonly operation: string;
  readonly symbol?: string | undefined;
  readonly cause?: unknown;
}

export abstract class ProviderError extends Error {
  abstract readonly kind: ProviderErrorKind;
  /** Whether retrying the identical request could plausibly succeed. */
  abstract readonly retryable: boolean;

  readonly provider: string;
  readonly operation: string;
  readonly symbol: string | undefined;

  constructor(message: string, context: ProviderErrorContext) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = new.target.name;
    this.provider = context.provider;
    this.operation = context.operation;
    this.symbol = context.symbol;
  }

  /** Structured form for logging and for `provider_health` persistence. */
  toJSON(): Record<string, unknown> {
    return {
      kind: this.kind,
      name: this.name,
      message: this.message,
      provider: this.provider,
      operation: this.operation,
      symbol: this.symbol,
      retryable: this.retryable,
    };
  }
}

/**
 * The provider refused the request because we exceeded its quota.
 *
 * `retryAfterMs` is populated from a Retry-After header when present. Yahoo
 * publishes no rate limits at all, so for that provider the value is a
 * heuristic rather than a promise.
 */
export class RateLimitedError extends ProviderError {
  override readonly kind = 'rate-limited' as const;
  override readonly retryable = true;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    context: ProviderErrorContext & { retryAfterMs?: number | undefined },
  ) {
    super(message, context);
    this.retryAfterMs = context.retryAfterMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs };
  }
}

/** Network failure, timeout, 5xx, or an outright unreachable host. */
export class ProviderUnavailableError extends ProviderError {
  override readonly kind = 'provider-unavailable' as const;
  override readonly retryable = true;
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    context: ProviderErrorContext & { statusCode?: number | undefined },
  ) {
    super(message, context);
    this.statusCode = context.statusCode;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), statusCode: this.statusCode };
  }
}

/**
 * The provider responded correctly, but the requested data does not exist -
 * an unlisted ticker, or an equity with no listed options. Retrying is futile
 * and, across a 500-name universe, expensive.
 */
export class MissingDataError extends ProviderError {
  override readonly kind = 'missing-data' as const;
  override readonly retryable = false;
}

/**
 * The response did not match the expected shape.
 *
 * This is the expected failure mode for undocumented endpoints: `yahoo-finance2`
 * surfaces it as a validation error whenever Yahoo drifts a field, and several
 * such drifts occurred during 2026. Treated as non-retryable because the same
 * request will produce the same unparseable response.
 */
export class InvalidResponseError extends ProviderError {
  override readonly kind = 'invalid-response' as const;
  override readonly retryable = false;
  readonly detail: string | undefined;

  constructor(
    message: string,
    context: ProviderErrorContext & { detail?: string | undefined },
  ) {
    super(message, context);
    this.detail = context.detail;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), detail: this.detail };
  }
}

/**
 * Data was retrieved but is older than the caller's freshness requirement.
 *
 * Carried as an error type so a caller can choose to accept it - the UI shows
 * stale data with a warning rather than showing nothing.
 */
export class StaleDataError extends ProviderError {
  override readonly kind = 'stale-data' as const;
  override readonly retryable = true;
  readonly ageMs: number;
  readonly maxAgeMs: number;

  constructor(
    message: string,
    context: ProviderErrorContext & { ageMs: number; maxAgeMs: number },
  ) {
    super(message, context);
    this.ageMs = context.ageMs;
    this.maxAgeMs = context.maxAgeMs;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ageMs: this.ageMs, maxAgeMs: this.maxAgeMs };
  }
}

/** The provider does not implement this capability at all. */
export class NotSupportedError extends ProviderError {
  override readonly kind = 'not-supported' as const;
  override readonly retryable = false;
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/** True when retrying the identical request could plausibly succeed. */
export function isRetryable(value: unknown): boolean {
  return isProviderError(value) && value.retryable;
}
