import { ema } from './moving-averages';
import { rateOfChange, rsi, trailingReturn } from './momentum';
import { atr, atrPercent, historicalVolatility } from './volatility';
import {
  supportResistance,
  trailingRange,
  vwap,
  type SupportResistance,
  type PriceRange,
} from './levels';
import { classifyTrend, type TrendAssessment } from './trend';
import { assertBars, latest, type Bar } from './types';

export { sma, ema, wilderSmooth } from './moving-averages';
export { rsi, rateOfChange, trailingReturn } from './momentum';
export {
  atr,
  atrPercent,
  trueRange,
  historicalVolatility,
  TRADING_DAYS_PER_YEAR,
} from './volatility';
export {
  supportResistance,
  swingHighs,
  swingLows,
  trailingRange,
  vwap,
  type PriceLevel,
  type SupportResistance,
  type PriceRange,
  type SwingOptions,
} from './levels';
export {
  classifyTrend,
  type TrendAssessment,
  type TrendLabel,
  type TrendInputs,
} from './trend';
export { latest, assertBars, type Bar, type IndicatorSeries } from './types';

/**
 * Everything the strategy and scoring engines need from price history, computed
 * once per symbol per scan.
 *
 * Every field is nullable, because a name with 30 days of history genuinely has
 * no 200 EMA. Downstream code must handle that rather than receive a plausible
 * substitute - a fabricated long-term average would most affect exactly the
 * newly-listed, thinly-traded names that carry the most risk.
 */
export interface IndicatorSnapshot {
  readonly price: number;
  readonly barCount: number;

  readonly ema20: number | null;
  readonly ema50: number | null;
  readonly ema100: number | null;
  readonly ema200: number | null;

  readonly rsi14: number | null;
  readonly roc20: number | null;
  readonly return1m: number | null;
  readonly return3m: number | null;

  readonly atr14: number | null;
  readonly atrPercent14: number | null;
  readonly hv20: number | null;
  readonly hv60: number | null;

  readonly trend: TrendAssessment;
  readonly levels: SupportResistance;
  readonly range52w: PriceRange | null;
  readonly vwap20: number | null;
}

/**
 * Computes the full indicator set from daily bars.
 *
 * `price` defaults to the last close but should be passed explicitly when a
 * live quote is available, so that indicator comparisons ("price above 200
 * EMA") use the same price the opportunity is priced against.
 */
export function computeIndicators(
  bars: readonly Bar[],
  price?: number,
): IndicatorSnapshot {
  assertBars(bars);

  const closes = bars.map((b) => b.close);
  const lastClose = closes.length > 0 ? (closes[closes.length - 1] as number) : 0;
  const referencePrice = price ?? lastClose;

  const ema20 = latest(ema(closes, 20));
  const ema50 = latest(ema(closes, 50));
  const ema100 = latest(ema(closes, 100));
  const ema200 = latest(ema(closes, 200));

  return {
    price: referencePrice,
    barCount: bars.length,

    ema20,
    ema50,
    ema100,
    ema200,

    rsi14: latest(rsi(closes, 14)),
    roc20: latest(rateOfChange(closes, 20)),
    return1m: trailingReturn(closes, 21),
    return3m: trailingReturn(closes, 63),

    atr14: latest(atr(bars, 14)),
    atrPercent14: latest(atrPercent(bars, 14)),
    hv20: latest(historicalVolatility(closes, 20)),
    hv60: latest(historicalVolatility(closes, 60)),

    trend: classifyTrend({ price: referencePrice, ema20, ema50, ema100, ema200 }),
    levels:
      referencePrice > 0
        ? supportResistance(bars, referencePrice)
        : {
            supports: [],
            resistances: [],
            nearestSupport: null,
            nearestResistance: null,
          },
    range52w: trailingRange(bars, referencePrice, 252),
    vwap20: vwap(bars.slice(Math.max(0, bars.length - 20))),
  };
}
