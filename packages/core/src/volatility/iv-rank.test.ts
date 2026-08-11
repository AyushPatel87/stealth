import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_IV_OBSERVATIONS,
  ivHvRatio,
  ivRank,
  volatilityRichnessLabel,
  type IvObservation,
} from './iv-rank.js';

function history(values: readonly number[]): IvObservation[] {
  return values.map((iv, i) => ({
    date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000)
      .toISOString()
      .slice(0, 10),
    iv,
  }));
}

/** A 120-observation series oscillating between 0.20 and 0.40. */
const LONG_HISTORY = history(
  Array.from({ length: 120 }, (_, i) => 0.3 + 0.1 * Math.sin(i / 6)),
);

describe('ivRank - the cold-start guard', () => {
  it('refuses to produce a rank from too little history', () => {
    // This is the whole point of the module: a rank over 11 days looks exactly
    // like a rank over a year and means far less.
    const result = ivRank(0.35, history([0.2, 0.3, 0.4]));

    expect(result.rank).toBeNull();
    expect(result.percentile).toBeNull();
    expect(result.sufficient).toBe(false);
    expect(result.windowDays).toBe(3);
    expect(result.minObservations).toBe(DEFAULT_MIN_IV_OBSERVATIONS);
  });

  it('always reports the window it used, so the UI can label it', () => {
    const result = ivRank(0.35, LONG_HISTORY);
    expect(result.sufficient).toBe(true);
    expect(result.windowDays).toBe(120);
  });

  it('becomes sufficient exactly at the configured minimum', () => {
    const flat = history(new Array(60).fill(0.3));
    expect(ivRank(0.3, flat.slice(0, 59)).sufficient).toBe(false);
    expect(ivRank(0.3, flat).sufficient).toBe(true);
  });

  it('honours a custom minimum for callers willing to accept less history', () => {
    const result = ivRank(0.35, history([0.2, 0.3, 0.4, 0.35, 0.25]), {
      minObservations: 5,
    });
    expect(result.sufficient).toBe(true);
    expect(result.rank).not.toBeNull();
  });
});

describe('ivRank - computation', () => {
  const range = history([
    ...new Array(30).fill(0.2),
    ...new Array(30).fill(0.4),
  ]);

  it('places current IV within the observed high-low range', () => {
    expect(ivRank(0.3, range)?.rank).toBeCloseTo(50, 6);
    expect(ivRank(0.2, range)?.rank).toBeCloseTo(0, 6);
    expect(ivRank(0.4, range)?.rank).toBeCloseTo(100, 6);
  });

  it('computes percentile as the fraction of observations below current IV', () => {
    // Half the observations sit at 0.2, so IV of 0.3 exceeds 50% of them.
    expect(ivRank(0.3, range)?.percentile).toBeCloseTo(50, 6);
  });

  it('distinguishes rank from percentile when a spike distorts the range', () => {
    // 59 observations at 0.20 and one at 1.00. Current 0.22 is above almost
    // everything (high percentile) but barely off the range floor (low rank).
    const spiked = history([...new Array(59).fill(0.2), 1.0]);
    const result = ivRank(0.22, spiked);

    expect(result.percentile as number).toBeGreaterThan(90);
    expect(result.rank as number).toBeLessThan(5);
  });

  it('clamps IV outside the historical range to [0, 100]', () => {
    expect(ivRank(0.05, range)?.rank).toBe(0);
    expect(ivRank(5, range)?.rank).toBe(100);
  });

  it('returns 50 for a perfectly flat history rather than dividing by zero', () => {
    const flat = history(new Array(60).fill(0.3));
    expect(ivRank(0.3, flat)?.rank).toBe(50);
  });

  it('limits the lookback to the configured window', () => {
    const result = ivRank(0.3, LONG_HISTORY, { windowSize: 90 });
    expect(result.windowDays).toBe(90);
  });

  it('reports the observed low and high', () => {
    const result = ivRank(0.3, range);
    expect(result.low).toBeCloseTo(0.2, 9);
    expect(result.high).toBeCloseTo(0.4, 9);
  });

  it('discards non-finite and non-positive observations', () => {
    const dirty = history([
      ...new Array(60).fill(0.3),
      Number.NaN,
      0,
      -1,
    ]);
    expect(ivRank(0.3, dirty).windowDays).toBe(60);
  });

  it('rejects a non-positive current IV', () => {
    expect(ivRank(0, LONG_HISTORY).rank).toBeNull();
    expect(ivRank(Number.NaN, LONG_HISTORY).rank).toBeNull();
  });

  it('handles empty history', () => {
    const result = ivRank(0.3, []);
    expect(result.windowDays).toBe(0);
    expect(result.sufficient).toBe(false);
    expect(result.rank).toBeNull();
  });
});

describe('ivHvRatio - the day-one substitute', () => {
  it('expresses implied volatility as a multiple of realised', () => {
    const result = ivHvRatio(0.35, 0.28);
    expect(result.ratio).toBeCloseTo(1.25, 9);
    expect(result.premium).toBeCloseTo(0.25, 9);
  });

  it('reports a negative premium when options are cheap to realised', () => {
    const result = ivHvRatio(0.2, 0.3);
    expect(result.ratio as number).toBeLessThan(1);
    expect(result.premium as number).toBeLessThan(0);
  });

  it('returns nulls rather than dividing by zero or NaN', () => {
    expect(ivHvRatio(0.35, 0).ratio).toBeNull();
    expect(ivHvRatio(0.35, null).ratio).toBeNull();
    expect(ivHvRatio(0.35, Number.NaN).ratio).toBeNull();
    expect(ivHvRatio(0, 0.3).ratio).toBeNull();
  });

  it('preserves the inputs for display even when the ratio is unavailable', () => {
    const result = ivHvRatio(0.35, null);
    expect(result.impliedVolatility).toBe(0.35);
    expect(result.historicalVolatility).toBeNull();
  });
});

describe('volatilityRichnessLabel', () => {
  it('prefers IV Rank once the window is sufficient, and states the window', () => {
    const label = volatilityRichnessLabel(
      ivRank(0.35, LONG_HISTORY),
      ivHvRatio(0.35, 0.28),
    );
    expect(label).toMatch(/^IV Rank \d+ \(120d window\)$/);
  });

  it('falls back to IV/HV and says how much more history is needed', () => {
    const label = volatilityRichnessLabel(
      ivRank(0.35, history(new Array(10).fill(0.3))),
      ivHvRatio(0.35, 0.28),
    );
    expect(label).toContain('IV/HV 1.25');
    expect(label).toContain('50 more days');
  });

  it('says so plainly when neither signal is available', () => {
    expect(
      volatilityRichnessLabel(ivRank(0.35, []), ivHvRatio(0.35, null)),
    ).toBe('Volatility richness unavailable');
  });
});
