import { describe, expect, it } from 'vitest';
import {
  annualizedYield,
  distanceOtm,
  expectedMoveFromIv,
  expectedMoveFromStraddle,
  moneyness,
  premiumEstimate,
  premiumYield,
  shortOptionBreakeven,
  sigmasFromSpot,
} from './metrics.js';

describe('premiumEstimate', () => {
  it('computes mid, conservative and spread from a two-sided market', () => {
    const e = premiumEstimate({ bid: 1.3, ask: 1.4 });
    expect(e.source).toBe('bid-ask');
    expect(e.mid).toBeCloseTo(1.35, 12);
    expect(e.conservative).toBe(1.3);
    expect(e.spreadAbs).toBeCloseTo(0.1, 12);
    expect(e.spreadPct).toBeCloseTo(0.1 / 1.35, 12);
    expect(e.crossed).toBe(false);
  });

  it('uses the bid, not the mid, as the sellers estimate', () => {
    // A 20-cent-wide market on a $1.00 mid: the mid overstates a seller's
    // realistic credit by 10%, and this is the case liquidity scoring must see.
    const e = premiumEstimate({ bid: 0.9, ask: 1.1 });
    expect(e.mid).toBeCloseTo(1.0, 12);
    expect(e.conservative).toBe(0.9);
    expect(e.spreadPct).toBeCloseTo(0.2, 12);
  });

  it('falls back to last trade when the market is one-sided', () => {
    // Yahoo omits bid/ask entirely on thin contracts - not null, absent.
    const e = premiumEstimate({ last: 2.4 });
    expect(e.source).toBe('last-only');
    expect(e.mid).toBe(2.4);
    expect(e.conservative).toBe(2.4);
    expect(e.spreadPct).toBeNull();
  });

  it('prefers a two-sided market over a stale last trade', () => {
    const e = premiumEstimate({ bid: 1.0, ask: 1.2, last: 9.99 });
    expect(e.source).toBe('bid-ask');
    expect(e.mid).toBeCloseTo(1.1, 12);
  });

  it('reports unavailable rather than guessing when nothing is quoted', () => {
    expect(premiumEstimate({}).source).toBe('unavailable');
    expect(premiumEstimate({}).mid).toBeNull();
    expect(premiumEstimate({ last: 0 }).source).toBe('unavailable');
  });

  it('flags a crossed market instead of returning a negative spread', () => {
    const e = premiumEstimate({ bid: 1.5, ask: 1.2 });
    expect(e.crossed).toBe(true);
    expect(e.spreadAbs).toBeLessThan(0);
  });

  it('handles a zero bid, which is common on far OTM contracts', () => {
    const e = premiumEstimate({ bid: 0, ask: 0.05 });
    expect(e.source).toBe('bid-ask');
    expect(e.mid).toBeCloseTo(0.025, 12);
    expect(e.conservative).toBe(0);
    // A 0 x 0.05 market is 200% wide - correctly unattractive.
    expect(e.spreadPct).toBeCloseTo(2, 12);
  });

  it('ignores NaN and negative quotes without throwing', () => {
    expect(premiumEstimate({ bid: Number.NaN, ask: 1.2 }).source).toBe(
      'unavailable',
    );
    expect(premiumEstimate({ bid: -1, ask: 1.2 }).source).toBe('unavailable');
    expect(
      premiumEstimate({ bid: Number.POSITIVE_INFINITY, ask: 1.2 }).source,
    ).toBe('unavailable');
  });
});

describe('distanceOtm', () => {
  it('is positive for an out-of-the-money put', () => {
    expect(distanceOtm(462, 440, 'put')).toBeCloseTo(22 / 462, 12);
  });

  it('is positive for an out-of-the-money call', () => {
    expect(distanceOtm(462, 480, 'call')).toBeCloseTo(18 / 462, 12);
  });

  it('is negative when in the money', () => {
    expect(distanceOtm(462, 480, 'put')).toBeLessThan(0);
    expect(distanceOtm(462, 440, 'call')).toBeLessThan(0);
  });

  it('is zero at the money', () => {
    expect(distanceOtm(100, 100, 'put')).toBe(0);
    expect(distanceOtm(100, 100, 'call')).toBe(0);
  });

  it('rejects a non-positive spot', () => {
    expect(() => distanceOtm(0, 100, 'put')).toThrow(RangeError);
    expect(() => distanceOtm(-5, 100, 'put')).toThrow(RangeError);
  });
});

describe('moneyness', () => {
  it('is 1 at the money and scales with strike', () => {
    expect(moneyness(100, 100)).toBe(1);
    expect(moneyness(100, 120)).toBeCloseTo(1.2, 12);
    expect(moneyness(100, 80)).toBeCloseTo(0.8, 12);
  });
});

describe('premiumYield', () => {
  it('divides premium by the capital committed', () => {
    // CSP: $1.35 credit against a $440 strike = 0.307% for the period.
    expect(premiumYield(1.35, 440)).toBeCloseTo(0.0030681818, 9);
  });

  it('rejects a non-positive capital base', () => {
    expect(() => premiumYield(1, 0)).toThrow(RangeError);
    expect(() => premiumYield(1, -100)).toThrow(RangeError);
  });
});

describe('annualizedYield', () => {
  it('scales a period yield linearly for the simple convention', () => {
    // 1% over 30 days -> 12.167% simple.
    const y = annualizedYield(0.01, 30);
    expect(y.simple).toBeCloseTo(0.01 * (365 / 30), 12);
  });

  it('compounds to a higher figure than simple for positive yields', () => {
    const y = annualizedYield(0.01, 7);
    expect(y.compounded).toBeGreaterThan(y.simple);
    expect(y.compounded).toBeCloseTo(Math.pow(1.01, 365 / 7) - 1, 10);
  });

  it('agrees with simple over a full year', () => {
    const y = annualizedYield(0.08, 365);
    expect(y.simple).toBeCloseTo(0.08, 12);
    expect(y.compounded).toBeCloseTo(0.08, 12);
  });

  it('handles a total loss without producing NaN', () => {
    expect(annualizedYield(-1, 30).compounded).toBe(Number.NEGATIVE_INFINITY);
    expect(annualizedYield(-1.5, 30).compounded).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it('rejects a non-positive holding period', () => {
    expect(() => annualizedYield(0.01, 0)).toThrow(RangeError);
    expect(() => annualizedYield(0.01, -7)).toThrow(RangeError);
  });
});

describe('expectedMoveFromIv', () => {
  it('computes S * sigma * sqrt(T)', () => {
    // The PRD's worked example: $462 underlying, expected move about +/- $21.
    const em = expectedMoveFromIv(462, 0.25, 30 / 365);
    expect(em.move).toBeCloseTo(462 * 0.25 * Math.sqrt(30 / 365), 12);
    expect(em.move).toBeCloseTo(33.1, 1);
    expect(em.lower).toBeCloseTo(462 - em.move, 12);
    expect(em.upper).toBeCloseTo(462 + em.move, 12);
    expect(em.confidence).toBe(0.68);
  });

  it('scales with the square root of time, not linearly', () => {
    const short = expectedMoveFromIv(100, 0.3, 30 / 365);
    const long = expectedMoveFromIv(100, 0.3, 120 / 365);
    // Four times the duration is exactly twice the move.
    expect(long.move / short.move).toBeCloseTo(2, 10);
  });

  it('is zero at expiry and at zero volatility', () => {
    expect(expectedMoveFromIv(100, 0.3, 0).move).toBe(0);
    expect(expectedMoveFromIv(100, 0, 0.5).move).toBe(0);
  });

  it('rejects invalid inputs', () => {
    expect(() => expectedMoveFromIv(0, 0.3, 0.5)).toThrow(RangeError);
    expect(() => expectedMoveFromIv(100, -0.3, 0.5)).toThrow(RangeError);
    expect(() => expectedMoveFromIv(100, 0.3, -0.5)).toThrow(RangeError);
  });
});

describe('expectedMoveFromStraddle', () => {
  it('applies the 0.85 straddle rule of thumb', () => {
    const em = expectedMoveFromStraddle(462, 25);
    expect(em.move).toBeCloseTo(21.25, 12);
  });

  it('broadly agrees with the IV-derived move for an ATM straddle', () => {
    // Cross-check: price a real ATM straddle, then compare both estimators.
    const spot = 100;
    const iv = 0.3;
    const years = 30 / 365;
    const fromIv = expectedMoveFromIv(spot, iv, years);
    // ATM straddle ~ 0.8 * S * sigma * sqrt(T) * 2 by the standard approximation.
    const straddle = 2 * 0.4 * spot * iv * Math.sqrt(years);
    const fromStraddle = expectedMoveFromStraddle(spot, straddle);
    expect(fromStraddle.move / fromIv.move).toBeGreaterThan(0.5);
    expect(fromStraddle.move / fromIv.move).toBeLessThan(1.0);
  });
});

describe('shortOptionBreakeven', () => {
  it('subtracts the credit for a short put', () => {
    expect(shortOptionBreakeven(440, 1.35, 'put')).toBeCloseTo(438.65, 12);
  });

  it('adds the credit for a short call', () => {
    expect(shortOptionBreakeven(480, 2.1, 'call')).toBeCloseTo(482.1, 12);
  });
});

describe('sigmasFromSpot', () => {
  it('expresses a strike distance in standard deviations', () => {
    // Strike $21 below a $462 spot, with a $21 expected move, is exactly -1 sigma.
    expect(sigmasFromSpot(462, 441, 21)).toBeCloseTo(-1, 12);
    expect(sigmasFromSpot(462, 483, 21)).toBeCloseTo(1, 12);
  });

  it('returns null when there is no move to normalise by', () => {
    expect(sigmasFromSpot(100, 90, 0)).toBeNull();
    expect(sigmasFromSpot(100, 90, -1)).toBeNull();
  });
});
