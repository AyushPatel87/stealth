/**
 * Shared types for the technical-analysis engine.
 *
 * PRICE BASIS
 * -----------
 * Indicators run on `close`, which providers deliver SPLIT-adjusted. They do
 * NOT run on `adjClose`, which is additionally DIVIDEND-adjusted.
 *
 * That choice is deliberate and matters: option strikes are quoted against the
 * actual traded price, so a 200 EMA computed on dividend-adjusted history would
 * drift below the series the strike is compared against, by the cumulative
 * dividend yield over the lookback. For a 200-day EMA on a 3%-yielding name
 * that is a systematic error of well over 1%, which is enough to flip a
 * "price above 200 EMA" filter.
 *
 * `adjClose` is retained on the bar for total-return calculations, where it is
 * the correct basis.
 */

export interface Bar {
  /** Trading session date, ISO `YYYY-MM-DD`. */
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  /** Split-adjusted close. The basis for all indicators here. */
  readonly close: number;
  readonly volume: number;
  /** Split- AND dividend-adjusted close, when the provider supplies it. */
  readonly adjClose?: number | undefined;
}

/**
 * An indicator series aligned index-for-index with its input bars. Entries are
 * `null` through the warm-up period rather than omitted, so callers can index
 * by bar position without tracking an offset - the classic source of
 * off-by-one errors in TA code.
 */
export type IndicatorSeries = ReadonlyArray<number | null>;

/** Returns the most recent non-null value of a series, or null if there is none. */
export function latest(series: IndicatorSeries): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const value = series[i];
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Validates that a bar array is usable, throwing on structurally bad input. */
export function assertBars(bars: readonly Bar[]): void {
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) throw new RangeError(`bar at index ${i} is missing`);
    if (
      !Number.isFinite(bar.open) ||
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      !Number.isFinite(bar.close)
    ) {
      throw new RangeError(`bar at index ${i} (${bar.date}) has non-finite OHLC`);
    }
    if (bar.high < bar.low) {
      throw new RangeError(
        `bar at index ${i} (${bar.date}) has high ${bar.high} below low ${bar.low}`,
      );
    }
  }
}
