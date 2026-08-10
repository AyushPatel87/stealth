/**
 * TTL cache with explicit stale semantics.
 *
 * Serving stale data is a FEATURE here, not a bug to be avoided: when a
 * provider is rate-limited or down, a five-minute-old chain clearly labelled as
 * such is far more useful than an empty dashboard. So `get` distinguishes three
 * states rather than two - fresh, stale-but-present, and absent - and the caller
 * decides. What the cache will never do is hand back stale data that looks
 * fresh.
 *
 * The clock is injectable so cache expiry can be tested deterministically
 * without fake timers.
 */

export type Clock = () => number;

export interface CacheHit<T> {
  readonly value: T;
  /** True when still inside its TTL. */
  readonly fresh: boolean;
  readonly ageMs: number;
  readonly storedAt: Date;
}

interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export interface TtlCacheOptions {
  readonly clock?: Clock;
  /**
   * Maximum entries retained. Exceeding it evicts the least recently used.
   * A full S&P 500 + NASDAQ 100 scan holds one chain per symbol per
   * expiration, so an unbounded cache would grow without limit across a
   * long-running worker process.
   */
  readonly maxEntries?: number;
  /**
   * How long past expiry an entry stays available as stale. Beyond this it is
   * discarded entirely. Defaults to one hour.
   */
  readonly staleRetentionMs?: number;
}

export class TtlCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #clock: Clock;
  readonly #maxEntries: number;
  readonly #staleRetentionMs: number;

  constructor(options: TtlCacheOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#staleRetentionMs = options.staleRetentionMs ?? 3_600_000;
  }

  /**
   * Returns the entry with its freshness, or null when absent or past stale
   * retention. Reading refreshes LRU position.
   */
  get(key: string): CacheHit<T> | null {
    const entry = this.#entries.get(key);
    if (!entry) return null;

    const now = this.#clock();
    const ageMs = now - entry.storedAt;

    if (now > entry.expiresAt + this.#staleRetentionMs) {
      this.#entries.delete(key);
      return null;
    }

    // Refresh LRU position.
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return {
      value: entry.value,
      fresh: now <= entry.expiresAt,
      ageMs,
      storedAt: new Date(entry.storedAt),
    };
  }

  /** Returns the value only when fresh. Convenience for callers that cannot use stale data. */
  getFresh(key: string): T | null {
    const hit = this.get(key);
    return hit && hit.fresh ? hit.value : null;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (!(ttlMs >= 0)) {
      throw new RangeError(`ttlMs must be non-negative, got ${ttlMs}`);
    }
    const now = this.#clock();

    // Delete first so re-setting an existing key moves it to the LRU tail.
    this.#entries.delete(key);
    this.#entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });

    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Drops every entry past its stale-retention window. */
  prune(): number {
    const now = this.#clock();
    let removed = 0;
    for (const [key, entry] of this.#entries) {
      if (now > entry.expiresAt + this.#staleRetentionMs) {
        this.#entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Cache lifetimes by data class.
 *
 * Options chains are cached for 15 minutes deliberately: the free feeds are
 * themselves ~15 minutes delayed, so refetching more often spends rate-limit
 * budget to receive the same numbers back.
 */
export const CACHE_TTL_MS = {
  quote: 60_000,
  optionsChain: 900_000,
  expirations: 3_600_000,
  historicalBars: 86_400_000,
  earnings: 86_400_000,
  riskFreeRate: 86_400_000,
} as const satisfies Record<string, number>;

export type CacheClass = keyof typeof CACHE_TTL_MS;

/** Builds a collision-free cache key from an operation and its arguments. */
export function cacheKey(
  provider: string,
  operation: string,
  ...parts: readonly (string | number | null | undefined)[]
): string {
  return [provider, operation, ...parts.map((p) => p ?? '-')].join('|');
}
