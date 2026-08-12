/**
 * Momentum indicators: RSI, rate of change, and trailing returns.
 */

import type { IndicatorSeries } from './types';

/**
 * Relative Strength Index using Wilder's smoothing (the standard definition).
 *
 * Edge cases that a naive implementation gets wrong:
 *  - An unbroken run of up days gives an average loss of 0. RS is then infinite
 *    and RSI must saturate at 100, not produce NaN from 0/0.
 *  - An unbroken run of down days must give exactly 0.
 *  - A completely flat series has zero average gain AND loss; by convention
 *    that is RSI 50, not NaN.
 */
export function rsi(
  values: readonly number[],
  period = 14,
): IndicatorSeries {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period must be a positive integer, got ${period}`);
  }

  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
  }

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i += 1) {
    avgGain += gains[i] as number;
    avgLoss += losses[i] as number;
  }
  avgGain /= period;
  avgLoss /= period;

  // gains[j] corresponds to the change into values[j + 1].
  out[period] = rsiFrom(avgGain, avgLoss);

  for (let j = period; j < gains.length; j += 1) {
    avgGain = (avgGain * (period - 1) + (gains[j] as number)) / period;
    avgLoss = (avgLoss * (period - 1) + (losses[j] as number)) / period;
    out[j + 1] = rsiFrom(avgGain, avgLoss);
  }

  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    // No downside at all. Flat series (no upside either) is 50 by convention.
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Rate of change over `period` bars, as a fraction.
 * ROC_i = (v_i - v_(i-period)) / v_(i-period)
 */
export function rateOfChange(
  values: readonly number[],
  period: number,
): IndicatorSeries {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period must be a positive integer, got ${period}`);
  }

  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i += 1) {
    const past = values[i - period] as number;
    out[i] = past === 0 ? null : ((values[i] as number) - past) / past;
  }
  return out;
}

/**
 * Trailing return over the last `period` bars, as a fraction. Returns null when
 * there is insufficient history rather than silently using a shorter window,
 * which would make momentum look artificially strong for newly-listed names.
 */
export function trailingReturn(
  values: readonly number[],
  period: number,
): number | null {
  if (values.length <= period) return null;
  const past = values[values.length - 1 - period];
  const now = values[values.length - 1];
  if (past === undefined || now === undefined || past === 0) return null;
  return (now - past) / past;
}
