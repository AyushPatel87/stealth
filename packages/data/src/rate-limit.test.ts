import { describe, expect, it, vi } from 'vitest';
import { RateLimiter, withRetry, YAHOO_RATE_LIMIT } from './rate-limit';
import {
  MissingDataError,
  ProviderUnavailableError,
  RateLimitedError,
} from './errors';

const ctx = { provider: 'yahoo', operation: 'getQuote', symbol: 'AAPL' };

/** Clock advanced by the injected sleep, so no real time passes. */
function virtualTime(start = 0) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get elapsed() {
      return now - start;
    },
  };
}

describe('RateLimiter', () => {
  it('permits an immediate burst up to capacity', async () => {
    const t = virtualTime();
    const limiter = new RateLimiter({
      requestsPerInterval: 1,
      intervalMs: 1000,
      burst: 3,
      clock: t.now,
      sleep: t.sleep,
    });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(t.elapsed).toBe(0);
  });

  it('paces requests once the burst is spent', async () => {
    const t = virtualTime();
    const limiter = new RateLimiter({
      requestsPerInterval: 1,
      intervalMs: 1000,
      burst: 1,
      clock: t.now,
      sleep: t.sleep,
    });

    await limiter.acquire();
    expect(t.elapsed).toBe(0);
    await limiter.acquire();
    // Must have waited roughly one interval for the next token.
    expect(t.elapsed).toBeGreaterThanOrEqual(1000);
  });

  it('refills continuously rather than in discrete windows', async () => {
    // Continuous refill avoids the thundering herd at each window boundary.
    const t = virtualTime();
    const limiter = new RateLimiter({
      requestsPerInterval: 10,
      intervalMs: 1000,
      burst: 10,
      clock: t.now,
      sleep: t.sleep,
    });

    for (let i = 0; i < 10; i += 1) await limiter.acquire();
    expect(limiter.availableTokens).toBeLessThan(1);

    t.advance(500);
    // Half an interval should restore about half the capacity.
    expect(limiter.availableTokens).toBeGreaterThan(4);
    expect(limiter.availableTokens).toBeLessThan(6);
  });

  it('never exceeds capacity however long it idles', () => {
    const t = virtualTime();
    const limiter = new RateLimiter({
      requestsPerInterval: 5,
      intervalMs: 1000,
      burst: 5,
      clock: t.now,
      sleep: t.sleep,
    });
    t.advance(10_000_000);
    expect(limiter.availableTokens).toBe(5);
  });

  it('reports the wait until the next token', async () => {
    const t = virtualTime();
    const limiter = new RateLimiter({
      requestsPerInterval: 1,
      intervalMs: 1000,
      burst: 1,
      clock: t.now,
      sleep: t.sleep,
    });
    expect(limiter.msUntilAvailable()).toBe(0);
    await limiter.acquire();
    expect(limiter.msUntilAvailable()).toBeGreaterThan(0);
  });

  it('serves concurrent acquirers in call order', async () => {
    const t = virtualTime();
    const limiter = new RateLimiter({
      requestsPerInterval: 1,
      intervalMs: 100,
      burst: 1,
      clock: t.now,
      sleep: t.sleep,
    });

    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map(async (n) => {
        await limiter.acquire();
        order.push(n);
      }),
    );
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects nonsensical configuration', () => {
    expect(
      () => new RateLimiter({ requestsPerInterval: 0, intervalMs: 1000 }),
    ).toThrow(RangeError);
    expect(
      () => new RateLimiter({ requestsPerInterval: 1, intervalMs: 0 }),
    ).toThrow(RangeError);
  });

  it('paces Yahoo conservatively, below every reported throttling threshold', () => {
    expect(YAHOO_RATE_LIMIT.requestsPerInterval / YAHOO_RATE_LIMIT.intervalMs).toBe(
      1 / 1000,
    );
    expect(YAHOO_RATE_LIMIT.burst).toBeLessThanOrEqual(3);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const t = virtualTime();
    const op = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(op, { sleep: t.sleep })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(t.elapsed).toBe(0);
  });

  it('retries retryable errors and eventually succeeds', async () => {
    const t = virtualTime();
    const op = vi
      .fn()
      .mockRejectedValueOnce(new ProviderUnavailableError('502', ctx))
      .mockResolvedValue('ok');

    await expect(
      withRetry(op, { sleep: t.sleep, random: () => 0.5 }),
    ).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry non-retryable errors', async () => {
    // Across a 500-name universe, retrying "this ticker has no options" three
    // times is the difference between a scan completing and getting throttled.
    const t = virtualTime();
    const op = vi.fn().mockRejectedValue(new MissingDataError('none', ctx));

    await expect(withRetry(op, { sleep: t.sleep })).rejects.toBeInstanceOf(
      MissingDataError,
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('does not retry untyped errors', async () => {
    const op = vi.fn().mockRejectedValue(new Error('boom'));
    await expect(withRetry(op, { sleep: async () => {} })).rejects.toThrow('boom');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts and rethrows the last error', async () => {
    const t = virtualTime();
    const op = vi.fn().mockRejectedValue(new ProviderUnavailableError('502', ctx));

    await expect(
      withRetry(op, { maxAttempts: 3, sleep: t.sleep, random: () => 1 }),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('grows the backoff ceiling exponentially', async () => {
    const t = virtualTime();
    const delays: number[] = [];
    const op = vi.fn().mockRejectedValue(new ProviderUnavailableError('502', ctx));

    await expect(
      withRetry(op, {
        maxAttempts: 4,
        baseDelayMs: 1000,
        sleep: t.sleep,
        // random() = 1 would floor to the full ceiling; use just under 1 so we
        // observe the ceiling itself.
        random: () => 0.999999,
        onRetry: (_attempt, delayMs) => delays.push(delayMs),
      }),
    ).rejects.toBeTruthy();

    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeLessThan(1000);
    expect(delays[1]).toBeGreaterThan(1500);
    expect(delays[2]).toBeGreaterThan(3000);
  });

  it('applies full jitter so concurrent workers decorrelate', async () => {
    const t = virtualTime();
    const delays: number[] = [];
    const randoms = [0, 0.25, 0.5];
    let i = 0;

    await expect(
      withRetry(vi.fn().mockRejectedValue(new ProviderUnavailableError('x', ctx)), {
        maxAttempts: 4,
        baseDelayMs: 1000,
        sleep: t.sleep,
        random: () => randoms[i++] ?? 0,
        onRetry: (_a, d) => delays.push(d),
      }),
    ).rejects.toBeTruthy();

    // Full jitter samples uniformly in [0, ceiling], so a random of 0 sleeps 0.
    expect(delays[0]).toBe(0);
    expect(delays[1]).toBe(500);
    expect(delays[2]).toBe(2000);
  });

  it('honours retryAfterMs from a rate-limit error over computed backoff', async () => {
    const t = virtualTime();
    const delays: number[] = [];
    const op = vi
      .fn()
      .mockRejectedValueOnce(
        new RateLimitedError('slow down', { ...ctx, retryAfterMs: 7_500 }),
      )
      .mockResolvedValue('ok');

    await expect(
      withRetry(op, {
        sleep: t.sleep,
        random: () => 0,
        onRetry: (_a, d) => delays.push(d),
      }),
    ).resolves.toBe('ok');

    expect(delays[0]).toBe(7_500);
  });

  it('caps an excessive retryAfterMs at maxDelayMs', async () => {
    const t = virtualTime();
    const delays: number[] = [];
    const op = vi
      .fn()
      .mockRejectedValueOnce(
        new RateLimitedError('banned', { ...ctx, retryAfterMs: 86_400_000 }),
      )
      .mockResolvedValue('ok');

    await withRetry(op, {
      sleep: t.sleep,
      maxDelayMs: 30_000,
      random: () => 0,
      onRetry: (_a, d) => delays.push(d),
    });

    expect(delays[0]).toBe(30_000);
  });
});
