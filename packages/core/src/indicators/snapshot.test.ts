import { describe, expect, it } from 'vitest';
import { computeIndicators } from './index.js';
import type { Bar } from './types.js';

/** A 260-bar uptrending series, long enough to populate a 200 EMA. */
function uptrendBars(count = 260): Bar[] {
  const bars: Bar[] = [];
  let close = 80;
  for (let i = 0; i < count; i += 1) {
    close *= 1 + 0.0015 + 0.004 * Math.sin(i / 9);
    bars.push({
      date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      open: close * 0.997,
      high: close * 1.008,
      low: close * 0.992,
      close,
      volume: 2_000_000,
    });
  }
  return bars;
}

describe('computeIndicators', () => {
  it('populates the full snapshot given sufficient history', () => {
    const bars = uptrendBars();
    const snap = computeIndicators(bars);

    expect(snap.barCount).toBe(260);
    expect(snap.ema20).not.toBeNull();
    expect(snap.ema50).not.toBeNull();
    expect(snap.ema100).not.toBeNull();
    expect(snap.ema200).not.toBeNull();
    expect(snap.rsi14).not.toBeNull();
    expect(snap.atr14).not.toBeNull();
    expect(snap.hv20).not.toBeNull();
    expect(snap.hv60).not.toBeNull();
    expect(snap.range52w).not.toBeNull();
    expect(snap.trend.complete).toBe(true);
  });

  it('orders the moving averages correctly in a sustained uptrend', () => {
    const snap = computeIndicators(uptrendBars());
    expect(snap.ema20 as number).toBeGreaterThan(snap.ema50 as number);
    expect(snap.ema50 as number).toBeGreaterThan(snap.ema200 as number);
    expect(snap.trend.label).toMatch(/uptrend/);
  });

  it('leaves long-period averages null rather than substituting a short one', () => {
    // 60 bars cannot support a 100 or 200 EMA. Fabricating one would most
    // affect newly-listed names, which carry the most risk for a put seller.
    const snap = computeIndicators(uptrendBars(60));
    expect(snap.ema20).not.toBeNull();
    expect(snap.ema50).not.toBeNull();
    expect(snap.ema100).toBeNull();
    expect(snap.ema200).toBeNull();
    expect(snap.trend.complete).toBe(false);
  });

  it('uses the supplied live price rather than the last close', () => {
    const bars = uptrendBars();
    const lastClose = (bars[bars.length - 1] as Bar).close;
    const snap = computeIndicators(bars, lastClose * 1.05);
    expect(snap.price).toBeCloseTo(lastClose * 1.05, 9);
    // Levels are classified against the live price, not the stale close.
    for (const level of snap.levels.supports) {
      expect(level.price).toBeLessThan(snap.price);
    }
  });

  it('defaults the reference price to the last close', () => {
    const bars = uptrendBars();
    const snap = computeIndicators(bars);
    expect(snap.price).toBeCloseTo((bars[bars.length - 1] as Bar).close, 12);
  });

  it('does not throw on a very short series', () => {
    const snap = computeIndicators(uptrendBars(3));
    expect(snap.barCount).toBe(3);
    expect(snap.ema20).toBeNull();
    expect(snap.rsi14).toBeNull();
    expect(snap.trend.label).toBe('neutral');
  });

  it('rejects structurally invalid bars', () => {
    const bars = uptrendBars(30);
    const broken = [...bars];
    broken[10] = { ...(bars[10] as Bar), high: 1, low: 999 };
    expect(() => computeIndicators(broken)).toThrow(RangeError);
  });
});
