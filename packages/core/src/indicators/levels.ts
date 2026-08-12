/**
 * Support and resistance detection.
 *
 * Derived from swing pivots, then clustered: price rarely revisits the exact
 * same number, so raw pivots produce dozens of near-duplicate levels a few
 * cents apart. Clustering within a percentage band turns those into one level
 * with a touch count, and touch count is the signal - a level tested four times
 * is meaningfully different from one touched once.
 */

import type { Bar } from './types';

export interface PriceLevel {
  /** Representative price for the cluster (volume-agnostic mean of pivots). */
  readonly price: number;
  /** How many distinct swing pivots formed this level. */
  readonly touches: number;
  /** Index of the most recent bar contributing to this level. */
  readonly lastTouchIndex: number;
  readonly kind: 'support' | 'resistance';
}

export interface SupportResistance {
  readonly supports: readonly PriceLevel[];
  readonly resistances: readonly PriceLevel[];
  /** Nearest level below the reference price, if any. */
  readonly nearestSupport: PriceLevel | null;
  /** Nearest level above the reference price, if any. */
  readonly nearestResistance: PriceLevel | null;
}

export interface SwingOptions {
  /**
   * Bars either side that a pivot must dominate. Larger values yield fewer,
   * more significant pivots. 5 approximates a two-week swing on daily bars.
   */
  readonly lookback?: number;
  /** Cluster width as a fraction of price. 0.01 groups levels within 1%. */
  readonly clusterTolerance?: number;
}

interface Pivot {
  readonly price: number;
  readonly index: number;
}

/** Indices of bars whose high dominates `lookback` bars on both sides. */
export function swingHighs(bars: readonly Bar[], lookback = 5): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = lookback; i < bars.length - lookback; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    let isPivot = true;
    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (j === i) continue;
      const other = bars[j];
      if (other && other.high >= bar.high) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push({ price: bar.high, index: i });
  }
  return pivots;
}

/** Indices of bars whose low dominates `lookback` bars on both sides. */
export function swingLows(bars: readonly Bar[], lookback = 5): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = lookback; i < bars.length - lookback; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    let isPivot = true;
    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (j === i) continue;
      const other = bars[j];
      if (other && other.low <= bar.low) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) pivots.push({ price: bar.low, index: i });
  }
  return pivots;
}

function clusterPivots(
  pivots: readonly Pivot[],
  tolerance: number,
  kind: 'support' | 'resistance',
): PriceLevel[] {
  if (pivots.length === 0) return [];

  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  let current: Pivot[] = [sorted[0] as Pivot];

  for (let i = 1; i < sorted.length; i += 1) {
    const pivot = sorted[i] as Pivot;
    const anchor = current[0] as Pivot;
    if (Math.abs(pivot.price - anchor.price) / anchor.price <= tolerance) {
      current.push(pivot);
    } else {
      clusters.push(current);
      current = [pivot];
    }
  }
  clusters.push(current);

  return clusters.map((cluster) => ({
    price: cluster.reduce((sum, p) => sum + p.price, 0) / cluster.length,
    touches: cluster.length,
    lastTouchIndex: Math.max(...cluster.map((p) => p.index)),
    kind,
  }));
}

/**
 * Builds clustered support and resistance levels, and identifies the nearest of
 * each relative to `referencePrice`.
 *
 * Levels are classified by position relative to the reference price rather than
 * by whether they came from a swing high or low, because a former resistance
 * that price has broken above genuinely acts as support.
 */
export function supportResistance(
  bars: readonly Bar[],
  referencePrice: number,
  options: SwingOptions = {},
): SupportResistance {
  const lookback = options.lookback ?? 5;
  const tolerance = options.clusterTolerance ?? 0.01;

  if (!(referencePrice > 0)) {
    throw new RangeError(
      `referencePrice must be positive, got ${referencePrice}`,
    );
  }

  const allPivots = [
    ...swingHighs(bars, lookback),
    ...swingLows(bars, lookback),
  ];

  const below = allPivots.filter((p) => p.price < referencePrice);
  const above = allPivots.filter((p) => p.price > referencePrice);

  const supports = clusterPivots(below, tolerance, 'support').sort(
    (a, b) => b.price - a.price,
  );
  const resistances = clusterPivots(above, tolerance, 'resistance').sort(
    (a, b) => a.price - b.price,
  );

  return {
    supports,
    resistances,
    nearestSupport: supports[0] ?? null,
    nearestResistance: resistances[0] ?? null,
  };
}

export interface PriceRange {
  readonly high: number;
  readonly low: number;
  /** Where price sits in the range: 0 at the low, 1 at the high. */
  readonly positionInRange: number;
}

/**
 * Highest high and lowest low over the trailing `bars` window (252 trading days
 * approximates 52 weeks), plus where the reference price sits within it.
 */
export function trailingRange(
  bars: readonly Bar[],
  referencePrice: number,
  window = 252,
): PriceRange | null {
  if (bars.length === 0) return null;

  const slice = bars.slice(Math.max(0, bars.length - window));
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;

  for (const bar of slice) {
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
  }

  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;

  const span = high - low;
  const positionInRange =
    span > 0 ? Math.min(Math.max((referencePrice - low) / span, 0), 1) : 0.5;

  return { high, low, positionInRange };
}

/**
 * Volume-weighted average price over the supplied bars, using the typical price
 * (H+L+C)/3 as each bar's representative price.
 *
 * On daily bars this is a rolling anchored VWAP, not the intraday VWAP a
 * trading platform displays. It is reported as such so the UI does not imply
 * intraday precision the daily data cannot support.
 */
export function vwap(bars: readonly Bar[]): number | null {
  let weighted = 0;
  let totalVolume = 0;

  for (const bar of bars) {
    if (!Number.isFinite(bar.volume) || bar.volume <= 0) continue;
    const typical = (bar.high + bar.low + bar.close) / 3;
    weighted += typical * bar.volume;
    totalVolume += bar.volume;
  }

  return totalVolume > 0 ? weighted / totalVolume : null;
}
