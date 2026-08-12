import { describe, expect, it } from 'vitest';
import { ema, sma, wilderSmooth } from './moving-averages';
import { rateOfChange, rsi, trailingReturn } from './momentum';
import {
  atr,
  atrPercent,
  historicalVolatility,
  trueRange,
} from './volatility';
import {
  supportResistance,
  swingHighs,
  swingLows,
  trailingRange,
  vwap,
} from './levels';
import { classifyTrend } from './trend';
import { assertBars, latest, type Bar } from './types';

/**
 * A deterministic synthetic close series. Reference values below were produced
 * by an independent Python implementation of each indicator over exactly this
 * data.
 */
const CLOSES = [
  100.0, 98.8, 99.954275, 101.135594, 99.950511, 100.798731, 101.613402,
  100.337256, 101.472469, 102.687979, 101.540362, 102.445285, 103.264849,
  101.914853, 103.019644, 104.253944, 103.138487, 104.110484, 104.951406,
  103.534355, 104.600733, 105.83773, 104.744777, 105.790371, 106.669231,
  105.196006, 106.22012, 107.444319, 106.360501, 107.481733, 108.413893,
  106.898694, 107.881299, 109.079089, 107.988279, 109.182431, 110.180755,
  108.640036, 109.586608, 110.74743, 109.631937,
];

/** Builds plausible OHLCV bars around the close series. */
function makeBars(closes: readonly number[]): Bar[] {
  return closes.map((close, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: close * 0.998,
    high: close * 1.006,
    low: close * 0.994,
    close,
    volume: 1_000_000 + i * 1000,
  }));
}

describe('sma', () => {
  it('matches an independent implementation', () => {
    expect(latest(sma(CLOSES, 10))).toBeCloseTo(108.9816558, 7);
  });

  it('is null through the warm-up period and defined from index period-1', () => {
    const s = sma(CLOSES, 10);
    expect(s.slice(0, 9).every((v) => v === null)).toBe(true);
    expect(s[9]).not.toBeNull();
  });

  it('returns all nulls when there is not enough data', () => {
    expect(sma([1, 2, 3], 10).every((v) => v === null)).toBe(true);
  });

  it('averages a constant series to the constant', () => {
    expect(latest(sma([5, 5, 5, 5, 5], 3))).toBeCloseTo(5, 12);
  });

  it('does not drift over a long series (rolling-sum stability)', () => {
    const long = Array.from({ length: 5000 }, (_, i) => 100 + (i % 7));
    const rolling = latest(sma(long, 50));
    const direct =
      long.slice(-50).reduce((a, b) => a + b, 0) / 50;
    expect(rolling).toBeCloseTo(direct, 9);
  });

  it('rejects an invalid period', () => {
    expect(() => sma(CLOSES, 0)).toThrow(RangeError);
    expect(() => sma(CLOSES, 2.5)).toThrow(RangeError);
  });
});

describe('ema', () => {
  it('matches an independent implementation for period 10 and 20', () => {
    expect(latest(ema(CLOSES, 10))).toBeCloseTo(109.02034781547668, 9);
    expect(latest(ema(CLOSES, 20))).toBeCloseTo(107.67694013688659, 9);
  });

  it('seeds with the SMA of the first period values', () => {
    const e = ema(CLOSES, 10);
    const s = sma(CLOSES, 10);
    // The seeding convention is what makes our EMA agree with charting
    // platforms; seeding from the first close instead leaves a decaying bias.
    expect(e[9]).toBeCloseTo(s[9] as number, 12);
  });

  it('converges to a constant series', () => {
    const flat = new Array(200).fill(42);
    expect(latest(ema(flat, 20))).toBeCloseTo(42, 12);
  });

  it('responds faster than the SMA of the same period', () => {
    const step = [...new Array(50).fill(100), ...new Array(10).fill(120)];
    const e = latest(ema(step, 20)) as number;
    const s = latest(sma(step, 20)) as number;
    expect(e).toBeGreaterThan(s);
  });
});

describe('wilderSmooth', () => {
  it('is smoother than a same-period EMA', () => {
    // Wilder uses 1/period rather than 2/(period+1), roughly halving
    // responsiveness. Substituting a normal EMA gives an RSI that disagrees
    // with every broker platform.
    const step = [...new Array(50).fill(100), ...new Array(10).fill(120)];
    const w = latest(wilderSmooth(step, 14)) as number;
    const e = latest(ema(step, 14)) as number;
    expect(w).toBeLessThan(e);
  });
});

describe('rsi', () => {
  it('matches an independent implementation', () => {
    const r = rsi(CLOSES, 14);
    expect(r[14]).toBeCloseTo(59.844100615178874, 9);
    expect(latest(r)).toBeCloseTo(59.56370764905209, 9);
  });

  it('is null before the first computable bar and defined at index period', () => {
    const r = rsi(CLOSES, 14);
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(r[14]).not.toBeNull();
  });

  it('saturates at 100 for an unbroken advance rather than dividing by zero', () => {
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(latest(rsi(rising, 14))).toBe(100);
  });

  it('saturates at 0 for an unbroken decline', () => {
    const falling = Array.from({ length: 40 }, (_, i) => 200 - i);
    expect(latest(rsi(falling, 14))).toBe(0);
  });

  it('returns 50 for a perfectly flat series rather than NaN', () => {
    const flat = new Array(40).fill(100);
    expect(latest(rsi(flat, 14))).toBe(50);
  });

  it('stays within [0, 100] on noisy data', () => {
    const noisy = Array.from(
      { length: 300 },
      (_, i) => 100 + 10 * Math.sin(i / 3) + 5 * Math.cos(i / 7),
    );
    for (const value of rsi(noisy, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('rateOfChange and trailingReturn', () => {
  it('computes rate of change as a fraction', () => {
    const roc = rateOfChange([100, 105, 110], 2);
    expect(roc[2]).toBeCloseTo(0.1, 12);
  });

  it('is null through the warm-up', () => {
    const roc = rateOfChange([100, 105, 110], 2);
    expect(roc[0]).toBeNull();
    expect(roc[1]).toBeNull();
  });

  it('guards against division by a zero base price', () => {
    expect(rateOfChange([0, 105], 1)[1]).toBeNull();
  });

  it('returns null for trailing return with insufficient history', () => {
    // Important for newly-listed names: a shorter window would make momentum
    // look artificially strong.
    expect(trailingReturn([100, 110], 20)).toBeNull();
    expect(trailingReturn(CLOSES, 20)).not.toBeNull();
  });
});

describe('trueRange and atr', () => {
  it('includes overnight gaps, not just the intraday range', () => {
    const bars: Bar[] = [
      { date: '2026-01-01', open: 100, high: 101, low: 99, close: 100, volume: 1 },
      // Gaps up to 110 then trades a narrow 1-point range.
      { date: '2026-01-02', open: 110, high: 110.5, low: 109.5, close: 110, volume: 1 },
    ];
    const tr = trueRange(bars);
    expect(tr[0]).toBeCloseTo(2, 12);
    // Intraday range is only 1, but the true range spans the gap from 100.
    expect(tr[1]).toBeCloseTo(10.5, 12);
  });

  it('uses high-minus-low for the first bar, which has no previous close', () => {
    const bars = makeBars(CLOSES.slice(0, 5));
    const tr = trueRange(bars);
    const first = bars[0] as Bar;
    expect(tr[0]).toBeCloseTo(first.high - first.low, 12);
  });

  it('produces a positive ATR and a sensible ATR percentage', () => {
    const bars = makeBars(CLOSES);
    const a = latest(atr(bars, 14));
    expect(a).not.toBeNull();
    expect(a as number).toBeGreaterThan(0);

    const pct = latest(atrPercent(bars, 14)) as number;
    // Bars span 1.2% of price by construction.
    expect(pct).toBeGreaterThan(0.005);
    expect(pct).toBeLessThan(0.05);
  });

  it('normalises across price levels so names are comparable', () => {
    const cheap = makeBars(CLOSES.map((c) => c / 10));
    const rich = makeBars(CLOSES.map((c) => c * 10));
    expect(latest(atrPercent(cheap, 14)) as number).toBeCloseTo(
      latest(atrPercent(rich, 14)) as number,
      9,
    );
  });
});

describe('historicalVolatility', () => {
  it('matches an independent implementation', () => {
    expect(latest(historicalVolatility(CLOSES, 20))).toBeCloseTo(
      0.170984090039663,
      9,
    );
  });

  it('is zero for a perfectly flat series', () => {
    expect(latest(historicalVolatility(new Array(60).fill(100), 20))).toBeCloseTo(
      0,
      12,
    );
  });

  it('uses the sample standard deviation, not the population form', () => {
    // The population form would understate 20-day vol by ~2.5%, which
    // propagates into the IV/HV ratio standing in for IV Rank.
    const closes = CLOSES.slice(0, 25);
    const sampleBased = latest(historicalVolatility(closes, 20)) as number;

    const logReturns: number[] = [];
    for (let i = 1; i < closes.length; i += 1) {
      logReturns.push(
        Math.log((closes[i] as number) / (closes[i - 1] as number)),
      );
    }
    const window = logReturns.slice(-20);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const populationVariance =
      window.reduce((acc, r) => acc + (r - mean) ** 2, 0) / window.length;
    const populationBased = Math.sqrt(populationVariance * 252);

    expect(sampleBased).toBeGreaterThan(populationBased);
    expect(sampleBased / populationBased).toBeCloseTo(
      Math.sqrt(20 / 19),
      9,
    );
  });

  it('scales with the annualisation factor', () => {
    const daily = latest(historicalVolatility(CLOSES, 20, 1)) as number;
    const annual = latest(historicalVolatility(CLOSES, 20, 252)) as number;
    expect(annual / daily).toBeCloseTo(Math.sqrt(252), 9);
  });

  it('rejects a period below 2', () => {
    expect(() => historicalVolatility(CLOSES, 1)).toThrow(RangeError);
  });
});

describe('support and resistance', () => {
  it('finds swing pivots that dominate their neighbours', () => {
    const closes = [10, 11, 12, 20, 12, 11, 10, 11, 12, 13, 14];
    const bars = makeBars(closes);
    const highs = swingHighs(bars, 3);
    expect(highs.length).toBeGreaterThan(0);
    expect(highs[0]?.index).toBe(3);
  });

  it('finds swing lows', () => {
    const closes = [20, 19, 18, 5, 18, 19, 20, 19, 18, 17, 16];
    const lows = swingLows(makeBars(closes), 3);
    expect(lows[0]?.index).toBe(3);
  });

  it('clusters near-duplicate levels into one with a touch count', () => {
    // Three pivots within 1% of each other should collapse to a single level.
    const closes = [
      100, 105, 110, 105, 100, 105, 110.2, 105, 100, 105, 110.1, 105, 100,
    ];
    const bars = makeBars(closes);
    const sr = supportResistance(bars, 102, { lookback: 2, clusterTolerance: 0.01 });
    const clustered = sr.resistances.find((l) => l.touches > 1);
    expect(clustered).toBeDefined();
    expect(clustered?.touches).toBeGreaterThanOrEqual(2);
  });

  it('classifies levels by position relative to the reference price', () => {
    const bars = makeBars(CLOSES);
    const sr = supportResistance(bars, 105, { lookback: 3 });
    for (const level of sr.supports) expect(level.price).toBeLessThan(105);
    for (const level of sr.resistances) expect(level.price).toBeGreaterThan(105);
  });

  it('orders nearest support just below and nearest resistance just above', () => {
    const bars = makeBars(CLOSES);
    const sr = supportResistance(bars, 105, { lookback: 3 });
    if (sr.nearestSupport) {
      expect(sr.nearestSupport.price).toBeLessThan(105);
      for (const level of sr.supports) {
        expect(level.price).toBeLessThanOrEqual(sr.nearestSupport.price);
      }
    }
    if (sr.nearestResistance) {
      expect(sr.nearestResistance.price).toBeGreaterThan(105);
      for (const level of sr.resistances) {
        expect(level.price).toBeGreaterThanOrEqual(sr.nearestResistance.price);
      }
    }
  });

  it('returns nulls rather than throwing when there are no pivots', () => {
    const sr = supportResistance(makeBars([100, 101]), 100, { lookback: 5 });
    expect(sr.nearestSupport).toBeNull();
    expect(sr.nearestResistance).toBeNull();
  });

  it('rejects a non-positive reference price', () => {
    expect(() => supportResistance(makeBars(CLOSES), 0)).toThrow(RangeError);
  });
});

describe('trailingRange', () => {
  it('reports the window high, low and position within the range', () => {
    const bars = makeBars(CLOSES);
    const range = trailingRange(bars, 105, 252);
    expect(range).not.toBeNull();
    expect(range?.high).toBeGreaterThan(range?.low as number);
    expect(range?.positionInRange).toBeGreaterThanOrEqual(0);
    expect(range?.positionInRange).toBeLessThanOrEqual(1);
  });

  it('clamps position when price sits outside the historical range', () => {
    const bars = makeBars(CLOSES);
    expect(trailingRange(bars, 1, 252)?.positionInRange).toBe(0);
    expect(trailingRange(bars, 10_000, 252)?.positionInRange).toBe(1);
  });

  it('returns 0.5 for a zero-width range instead of dividing by zero', () => {
    const flat: Bar[] = [
      { date: '2026-01-01', open: 50, high: 50, low: 50, close: 50, volume: 1 },
    ];
    expect(trailingRange(flat, 50)?.positionInRange).toBe(0.5);
  });

  it('returns null for an empty series', () => {
    expect(trailingRange([], 100)).toBeNull();
  });
});

describe('vwap', () => {
  it('weights typical price by volume', () => {
    const bars: Bar[] = [
      { date: '2026-01-01', open: 10, high: 12, low: 8, close: 10, volume: 100 },
      { date: '2026-01-02', open: 20, high: 22, low: 18, close: 20, volume: 300 },
    ];
    // Typical prices 10 and 20, weighted 100:300 -> 17.5
    expect(vwap(bars)).toBeCloseTo(17.5, 12);
  });

  it('ignores zero-volume bars and returns null when there is no volume', () => {
    const bars: Bar[] = [
      { date: '2026-01-01', open: 10, high: 12, low: 8, close: 10, volume: 0 },
    ];
    expect(vwap(bars)).toBeNull();
  });
});

describe('classifyTrend', () => {
  it('identifies a clean bullish stack', () => {
    const t = classifyTrend({
      price: 110,
      ema20: 108,
      ema50: 105,
      ema100: 102,
      ema200: 100,
    });
    expect(t.label).toBe('strong-uptrend');
    expect(t.score).toBe(100);
    expect(t.complete).toBe(true);
    expect(t.reasons).toContain('Price above 200 EMA');
  });

  it('identifies a clean bearish stack', () => {
    const t = classifyTrend({
      price: 90,
      ema20: 92,
      ema50: 95,
      ema100: 98,
      ema200: 100,
    });
    expect(t.label).toBe('strong-downtrend');
    expect(t.score).toBe(-100);
  });

  it('reports neutral for a genuine pullback within a longer uptrend', () => {
    // Price has dipped below its short-term averages but holds well above the
    // 200 EMA, and the 50 remains above the 200. The bullish long-term
    // structure (+35, +15) exactly offsets the short-term weakness
    // (-25, -15, -10), which is the definition of neutral here.
    const t = classifyTrend({
      price: 100,
      ema20: 101,
      ema50: 102,
      ema100: 98,
      ema200: 95,
    });
    expect(t.label).toBe('neutral');
    expect(t.score).toBe(0);
  });

  it('treats a death cross with price under the 200 EMA as a downtrend', () => {
    // Worth asserting explicitly: price straddling the 50 EMA can still be
    // clearly bearish once the 50 has crossed below the 200.
    const t = classifyTrend({
      price: 100,
      ema20: 101,
      ema50: 99,
      ema100: 100,
      ema200: 100.5,
    });
    expect(t.label).toBe('downtrend');
    expect(t.score).toBe(-30);
    expect(t.reasons).toContain('50 EMA below 200 EMA');
  });

  it('does not default to bullish when averages are missing', () => {
    // A newly-listed name has no 200 EMA. Scoring it as though the condition
    // passed would promote exactly the names with the least price history.
    const t = classifyTrend({
      price: 110,
      ema20: 108,
      ema50: null,
      ema100: null,
      ema200: null,
    });
    expect(t.complete).toBe(false);
    expect(t.reasons).not.toContain('Price above 200 EMA');
    // Only the 20 EMA condition was available, so it normalises to +100 but is
    // explicitly flagged incomplete for callers to down-weight.
    expect(t.score).toBe(100);
  });

  it('returns a neutral zero when nothing at all is available', () => {
    const t = classifyTrend({
      price: 110,
      ema20: null,
      ema50: null,
      ema100: null,
      ema200: null,
    });
    expect(t.score).toBe(0);
    expect(t.label).toBe('neutral');
    expect(t.complete).toBe(false);
  });
});

describe('assertBars', () => {
  it('accepts well-formed bars', () => {
    expect(() => assertBars(makeBars(CLOSES))).not.toThrow();
  });

  it('rejects a bar whose high is below its low', () => {
    const bars: Bar[] = [
      { date: '2026-01-01', open: 10, high: 8, low: 12, close: 10, volume: 1 },
    ];
    expect(() => assertBars(bars)).toThrow(RangeError);
  });

  it('rejects non-finite prices', () => {
    const bars: Bar[] = [
      {
        date: '2026-01-01',
        open: 10,
        high: Number.NaN,
        low: 8,
        close: 10,
        volume: 1,
      },
    ];
    expect(() => assertBars(bars)).toThrow(RangeError);
  });
});

describe('latest', () => {
  it('returns the last non-null value', () => {
    expect(latest([1, 2, 3])).toBe(3);
    expect(latest([1, 2, null])).toBe(2);
    expect(latest([null, null])).toBeNull();
    expect(latest([])).toBeNull();
  });
});
