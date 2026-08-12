/**
 * Volatility measures: Average True Range and historical (realised) volatility.
 */

import { wilderSmooth } from './moving-averages';
import type { Bar, IndicatorSeries } from './types';

/** Trading days per year, the standard annualisation factor for realised vol. */
export const TRADING_DAYS_PER_YEAR = 252;

/**
 * True Range: the greatest of the current bar's range, and the gap-inclusive
 * distances to the previous close.
 *
 * The previous-close terms are what make this "true" range rather than plain
 * high-minus-low: a stock that gaps 8% overnight and then trades a quiet
 * session has a large true range and a small intraday range. Omitting them
 * systematically understates volatility for gap-prone names, which are exactly
 * the ones a premium seller most needs flagged.
 */
export function trueRange(bars: readonly Bar[]): IndicatorSeries {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar) continue;
    if (i === 0) {
      // No previous close to gap from.
      out[i] = bar.high - bar.low;
      continue;
    }
    const prevClose = (bars[i - 1] as Bar).close;
    out[i] = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - prevClose),
      Math.abs(bar.low - prevClose),
    );
  }
  return out;
}

/**
 * Average True Range, smoothed with Wilder's method (the standard).
 */
export function atr(bars: readonly Bar[], period = 14): IndicatorSeries {
  const tr = trueRange(bars);
  const values = tr.map((v) => v ?? 0);
  return wilderSmooth(values, period);
}

/**
 * ATR expressed as a percentage of price, which makes it comparable across
 * names. A $5 ATR means something very different on a $40 stock than on a $900
 * one, so the raw figure cannot be used to rank a universe.
 */
export function atrPercent(
  bars: readonly Bar[],
  period = 14,
): IndicatorSeries {
  const atrSeries = atr(bars, period);
  return atrSeries.map((value, i) => {
    const bar = bars[i];
    if (value === null || !bar || bar.close <= 0) return null;
    return value / bar.close;
  });
}

/**
 * Annualised historical (realised) volatility from close-to-close log returns.
 *
 * Uses the SAMPLE standard deviation (n-1 denominator). With a 20-day window
 * the population form understates volatility by about 2.5%, which propagates
 * straight into the IV/HV ratio that stands in for IV Rank before enough
 * implied-volatility history has accumulated.
 */
export function historicalVolatility(
  closes: readonly number[],
  period = 20,
  annualisationFactor = TRADING_DAYS_PER_YEAR,
): IndicatorSeries {
  if (!Number.isInteger(period) || period < 2) {
    throw new RangeError(`period must be an integer >= 2, got ${period}`);
  }

  const out: (number | null)[] = new Array(closes.length).fill(null);

  const logReturns: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1] as number;
    const curr = closes[i] as number;
    logReturns[i] = prev > 0 && curr > 0 ? Math.log(curr / prev) : null;
  }

  for (let i = period; i < closes.length; i += 1) {
    const window: number[] = [];
    for (let j = i - period + 1; j <= i; j += 1) {
      const r = logReturns[j];
      if (r === null || r === undefined) break;
      window.push(r);
    }
    if (window.length < period) continue;

    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance =
      window.reduce((acc, r) => acc + (r - mean) ** 2, 0) /
      (window.length - 1);
    out[i] = Math.sqrt(variance * annualisationFactor);
  }

  return out;
}
