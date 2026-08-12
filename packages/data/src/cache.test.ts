import { describe, expect, it } from 'vitest';
import { CACHE_TTL_MS, TtlCache, cacheKey } from './cache';

/** Manually advanced clock, so expiry is tested without fake timers. */
function testClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('TtlCache', () => {
  it('returns a fresh hit inside the TTL', () => {
    const clock = testClock();
    const cache = new TtlCache<string>({ clock: clock.now });
    cache.set('a', 'value', 1000);

    clock.advance(500);
    const hit = cache.get('a');
    expect(hit?.value).toBe('value');
    expect(hit?.fresh).toBe(true);
    expect(hit?.ageMs).toBe(500);
  });

  it('returns a STALE hit past the TTL rather than dropping the value', () => {
    // Serving labelled stale data beats an empty dashboard when a provider is
    // down or rate-limited. What must never happen is stale data looking fresh.
    const clock = testClock();
    const cache = new TtlCache<string>({ clock: clock.now });
    cache.set('a', 'value', 1000);

    clock.advance(1500);
    const hit = cache.get('a');
    expect(hit?.value).toBe('value');
    expect(hit?.fresh).toBe(false);
    expect(hit?.ageMs).toBe(1500);
  });

  it('getFresh withholds stale values for callers that cannot use them', () => {
    const clock = testClock();
    const cache = new TtlCache<string>({ clock: clock.now });
    cache.set('a', 'value', 1000);
    expect(cache.getFresh('a')).toBe('value');

    clock.advance(1500);
    expect(cache.getFresh('a')).toBeNull();
    // ...but the stale value is still retrievable through get().
    expect(cache.get('a')?.value).toBe('value');
  });

  it('discards entries past the stale-retention window', () => {
    const clock = testClock();
    const cache = new TtlCache<string>({
      clock: clock.now,
      staleRetentionMs: 5000,
    });
    cache.set('a', 'value', 1000);

    clock.advance(1000 + 5000 + 1);
    expect(cache.get('a')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('returns null for an unknown key', () => {
    expect(new TtlCache<string>().get('missing')).toBeNull();
  });

  it('evicts least-recently-used entries beyond maxEntries', () => {
    const cache = new TtlCache<number>({ maxEntries: 3 });
    cache.set('a', 1, 10_000);
    cache.set('b', 2, 10_000);
    cache.set('c', 3, 10_000);

    // Touch 'a' so 'b' becomes least recently used.
    expect(cache.get('a')?.value).toBe(1);

    cache.set('d', 4, 10_000);
    expect(cache.size).toBe(3);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')?.value).toBe(1);
    expect(cache.get('d')?.value).toBe(4);
  });

  it('moves a re-set key to the most-recent position', () => {
    const cache = new TtlCache<number>({ maxEntries: 2 });
    cache.set('a', 1, 10_000);
    cache.set('b', 2, 10_000);
    cache.set('a', 11, 10_000);
    cache.set('c', 3, 10_000);

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')?.value).toBe(11);
  });

  it('supports delete, clear and prune', () => {
    const clock = testClock();
    const cache = new TtlCache<number>({
      clock: clock.now,
      staleRetentionMs: 1000,
    });
    cache.set('a', 1, 100);
    cache.set('b', 2, 100);

    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.size).toBe(1);

    clock.advance(2000);
    expect(cache.prune()).toBe(1);
    expect(cache.size).toBe(0);

    cache.set('c', 3, 100);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('treats a zero TTL as immediately stale but still retained', () => {
    const clock = testClock();
    const cache = new TtlCache<number>({ clock: clock.now });
    cache.set('a', 1, 0);
    clock.advance(1);
    expect(cache.get('a')?.fresh).toBe(false);
    expect(cache.getFresh('a')).toBeNull();
  });

  it('rejects a negative TTL', () => {
    expect(() => new TtlCache<number>().set('a', 1, -1)).toThrow(RangeError);
  });
});

describe('CACHE_TTL_MS', () => {
  it('caches options chains for the length of the feed delay', () => {
    // The free feeds are themselves ~15 minutes delayed, so refetching sooner
    // spends rate-limit budget to receive identical numbers.
    expect(CACHE_TTL_MS.optionsChain).toBe(15 * 60_000);
  });

  it('caches slow-moving data for a day', () => {
    expect(CACHE_TTL_MS.historicalBars).toBe(86_400_000);
    expect(CACHE_TTL_MS.earnings).toBe(86_400_000);
    expect(CACHE_TTL_MS.riskFreeRate).toBe(86_400_000);
  });

  it('keeps quotes much fresher than chains', () => {
    expect(CACHE_TTL_MS.quote).toBeLessThan(CACHE_TTL_MS.optionsChain);
  });
});

describe('cacheKey', () => {
  it('builds distinct keys per provider, operation and argument', () => {
    expect(cacheKey('yahoo', 'quote', 'AAPL')).toBe('yahoo|quote|AAPL');
    expect(cacheKey('yahoo', 'quote', 'AAPL')).not.toBe(
      cacheKey('alpaca', 'quote', 'AAPL'),
    );
    expect(cacheKey('yahoo', 'chain', 'AAPL', '2026-08-21')).not.toBe(
      cacheKey('yahoo', 'chain', 'AAPL', '2026-08-28'),
    );
  });

  it('renders null and undefined arguments stably', () => {
    expect(cacheKey('yahoo', 'chain', 'AAPL', null)).toBe('yahoo|chain|AAPL|-');
    expect(cacheKey('yahoo', 'chain', 'AAPL', undefined)).toBe(
      'yahoo|chain|AAPL|-',
    );
  });
});
