/**
 * Moving averages.
 *
 * The EMA is seeded with a simple moving average of the first `period` values,
 * matching TA-Lib and every charting platform a user will compare against.
 * Seeding with the first close instead (a common shortcut) leaves a decaying
 * bias that takes several periods to wash out - visible and wrong on a 200 EMA.
 */

import type { IndicatorSeries } from './types';

/** Simple moving average over `period` values. */
export function sma(values: readonly number[], period: number): IndicatorSeries {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period must be a positive integer, got ${period}`);
  }

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] as number;
    if (i >= period) {
      sum -= values[i - period] as number;
    }
    if (i >= period - 1) {
      out[i] = sum / period;
    }
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` values.
 *
 * EMA_i = price_i * k + EMA_(i-1) * (1 - k),  k = 2 / (period + 1)
 */
export function ema(values: readonly number[], period: number): IndicatorSeries {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period must be a positive integer, got ${period}`);
  }

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);

  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    seed += values[i] as number;
  }
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] as number) * k + prev * (1 - k);
    out[i] = prev;
  }

  return out;
}

/**
 * Wilder's smoothing (also called RMA or SMMA), used by RSI and ATR.
 *
 * Distinct from a standard EMA: the smoothing constant is 1/period rather than
 * 2/(period+1), which makes it roughly half as responsive. Using a normal EMA
 * here produces an RSI that disagrees with every broker platform.
 */
export function wilderSmooth(
  values: readonly number[],
  period: number,
): IndicatorSeries {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period must be a positive integer, got ${period}`);
  }

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i += 1) {
    seed += values[i] as number;
  }
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = (prev * (period - 1) + (values[i] as number)) / period;
    out[i] = prev;
  }

  return out;
}
