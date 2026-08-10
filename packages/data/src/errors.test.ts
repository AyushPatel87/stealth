import { describe, expect, it } from 'vitest';
import {
  InvalidResponseError,
  MissingDataError,
  ProviderUnavailableError,
  RateLimitedError,
  StaleDataError,
  NotSupportedError,
  isProviderError,
  isRetryable,
} from './errors.js';

const ctx = { provider: 'yahoo', operation: 'getOptionsChain', symbol: 'AAPL' };

describe('provider error taxonomy', () => {
  it('marks transient failures retryable and permanent ones not', () => {
    // This split is what stops a 500-name scan from hammering a rate-limited
    // API with retries for tickers that simply have no options listed.
    expect(new RateLimitedError('slow down', ctx).retryable).toBe(true);
    expect(new ProviderUnavailableError('502', ctx).retryable).toBe(true);
    expect(new StaleDataError('old', { ...ctx, ageMs: 1, maxAgeMs: 0 }).retryable).toBe(true);

    expect(new MissingDataError('no options listed', ctx).retryable).toBe(false);
    expect(new InvalidResponseError('schema drift', ctx).retryable).toBe(false);
    expect(new NotSupportedError('no greeks', ctx).retryable).toBe(false);
  });

  it('exposes a discriminating kind on every error', () => {
    expect(new RateLimitedError('x', ctx).kind).toBe('rate-limited');
    expect(new ProviderUnavailableError('x', ctx).kind).toBe('provider-unavailable');
    expect(new MissingDataError('x', ctx).kind).toBe('missing-data');
    expect(new InvalidResponseError('x', ctx).kind).toBe('invalid-response');
    expect(new StaleDataError('x', { ...ctx, ageMs: 1, maxAgeMs: 0 }).kind).toBe('stale-data');
    expect(new NotSupportedError('x', ctx).kind).toBe('not-supported');
  });

  it('preserves context for provider_health persistence', () => {
    const error = new RateLimitedError('too many requests', {
      ...ctx,
      retryAfterMs: 30_000,
    });
    expect(error.toJSON()).toMatchObject({
      kind: 'rate-limited',
      provider: 'yahoo',
      operation: 'getOptionsChain',
      symbol: 'AAPL',
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it('retains the underlying cause without losing the typed wrapper', () => {
    const cause = new Error('ECONNRESET');
    const error = new ProviderUnavailableError('network failure', {
      ...ctx,
      cause,
      statusCode: 503,
    });
    expect(error.cause).toBe(cause);
    expect(error.statusCode).toBe(503);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).toBeInstanceOf(Error);
  });

  it('reports a useful name rather than the base class name', () => {
    expect(new MissingDataError('x', ctx).name).toBe('MissingDataError');
  });

  it('records staleness magnitude so the UI can quantify it', () => {
    const error = new StaleDataError('stale', {
      ...ctx,
      ageMs: 900_000,
      maxAgeMs: 300_000,
    });
    expect(error.ageMs).toBe(900_000);
    expect(error.maxAgeMs).toBe(300_000);
  });

  it('identifies provider errors and retryability from unknown values', () => {
    expect(isProviderError(new MissingDataError('x', ctx))).toBe(true);
    expect(isProviderError(new Error('plain'))).toBe(false);
    expect(isProviderError(null)).toBe(false);
    expect(isProviderError('string')).toBe(false);

    expect(isRetryable(new RateLimitedError('x', ctx))).toBe(true);
    expect(isRetryable(new MissingDataError('x', ctx))).toBe(false);
    // An untyped error is not assumed retryable.
    expect(isRetryable(new Error('unknown'))).toBe(false);
  });

  it('allows retryAfterMs to be absent for providers that publish no limits', () => {
    // Yahoo publishes no rate limits at all, so no Retry-After is available.
    const error = new RateLimitedError('throttled', ctx);
    expect(error.retryAfterMs).toBeUndefined();
    expect(error.retryable).toBe(true);
  });
});
