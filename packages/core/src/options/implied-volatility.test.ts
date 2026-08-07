import { describe, expect, it } from 'vitest';
import { blackScholesPrice, type OptionRight } from './black-scholes.js';
import {
  impliedVolatility,
  priceBounds,
  type ImpliedVolInputs,
} from './implied-volatility.js';

/**
 * The strongest test for a root-finder is a round trip: price at a known
 * volatility, then recover it. If the solver and the pricer disagree anywhere,
 * this finds it without needing external reference data.
 */
describe('impliedVolatility - round trip against the pricer', () => {
  const rights: readonly OptionRight[] = ['call', 'put'];
  const spots = [50, 100, 462];
  const moneyness = [0.7, 0.9, 1.0, 1.1, 1.4];
  const expiries = [7 / 365, 30 / 365, 180 / 365, 2];
  const vols = [0.08, 0.2, 0.35, 0.8, 1.5];

  it('recovers the input volatility wherever it is identifiable', () => {
    let recovered = 0;
    let notIdentifiable = 0;
    const unexpected: string[] = [];

    for (const right of rights) {
      for (const spot of spots) {
        for (const m of moneyness) {
          for (const timeToExpiry of expiries) {
            for (const volatility of vols) {
              const strike = spot * m;
              const price = blackScholesPrice({
                spot,
                strike,
                timeToExpiry,
                volatility,
                riskFreeRate: 0.045,
                dividendYield: 0.01,
                right,
              });

              // Prices that round to zero carry no volatility information.
              if (price < 1e-8) continue;

              const outcome = impliedVolatility({
                price,
                spot,
                strike,
                timeToExpiry,
                riskFreeRate: 0.045,
                dividendYield: 0.01,
                right,
              });

              if (!outcome.ok) {
                // Deep-ITM contracts are legitimately ill-posed; anything else
                // failing is a real defect.
                if (outcome.reason === 'not-identifiable') {
                  notIdentifiable += 1;
                } else {
                  unexpected.push(
                    `${right} S=${spot} K=${strike} T=${timeToExpiry.toFixed(4)} vol=${volatility}: ${outcome.reason}`,
                  );
                }
                continue;
              }

              // Every contract the solver accepts as identifiable must recover
              // its volatility to near machine precision. The measured
              // worst case across this grid is 5.8e-10 relative; 1e-8 leaves
              // headroom without letting a regression hide.
              expect(
                Math.abs(outcome.result.volatility / volatility - 1),
              ).toBeLessThan(1e-8);
              recovered += 1;
            }
          }
        }
      }
    }

    expect(unexpected).toEqual([]);
    // Guard against the grid silently degenerating into nothing.
    expect(recovered).toBeGreaterThan(400);
    expect(notIdentifiable).toBeGreaterThan(0);
  });

  it('refuses to invent a volatility for deep-ITM contracts', () => {
    // Regression guard for a real defect: the solver previously returned 0.4156
    // for a contract priced at 8% volatility, because a 30-point-ITM 7-DTE call
    // prices identically at the bit level across that whole range.
    const inputs = {
      spot: 100,
      strike: 70,
      timeToExpiry: 7 / 365,
      riskFreeRate: 0.045,
      dividendYield: 0.01,
      right: 'call' as const,
    };
    const price = blackScholesPrice({ ...inputs, volatility: 0.08 });
    const outcome = impliedVolatility({ ...inputs, price });

    expect(outcome).toEqual({ ok: false, reason: 'not-identifiable' });
  });

  it('converges for deep OTM contracts where vega is tiny', () => {
    // This is the case Newton cannot handle and bisection must catch.
    const inputs = {
      spot: 100,
      strike: 160,
      timeToExpiry: 7 / 365,
      riskFreeRate: 0.045,
      right: 'call' as const,
    };
    const volatility = 0.9;
    const price = blackScholesPrice({ ...inputs, volatility });

    const outcome = impliedVolatility({ ...inputs, price });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.volatility).toBeCloseTo(volatility, 5);
    }
  });

  it('converges for very short-dated contracts', () => {
    const inputs = {
      spot: 462,
      strike: 460,
      timeToExpiry: 1 / 365,
      riskFreeRate: 0.045,
      right: 'put' as const,
    };
    const price = blackScholesPrice({ ...inputs, volatility: 0.55 });
    const outcome = impliedVolatility({ ...inputs, price });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.volatility).toBeCloseTo(0.55, 5);
    }
  });
});

describe('impliedVolatility - unsolvable quotes', () => {
  const base: Omit<ImpliedVolInputs, 'price'> = {
    spot: 100,
    strike: 100,
    timeToExpiry: 30 / 365,
    riskFreeRate: 0.045,
    right: 'call',
  };

  it('reports below-intrinsic rather than returning a bogus volatility', () => {
    // A call cannot trade below its discounted intrinsic value.
    const outcome = impliedVolatility({ ...base, strike: 50, price: 1 });
    expect(outcome).toEqual({ ok: false, reason: 'below-intrinsic' });
  });

  it('reports above-maximum for a price exceeding the underlying', () => {
    const outcome = impliedVolatility({ ...base, price: 500 });
    expect(outcome).toEqual({ ok: false, reason: 'above-maximum' });
  });

  it('rejects zero and negative prices', () => {
    expect(impliedVolatility({ ...base, price: 0 })).toEqual({
      ok: false,
      reason: 'non-positive-price',
    });
    expect(impliedVolatility({ ...base, price: -1 })).toEqual({
      ok: false,
      reason: 'non-positive-price',
    });
  });

  it('reports expired contracts distinctly', () => {
    const outcome = impliedVolatility({
      ...base,
      timeToExpiry: 0,
      price: 5,
    });
    expect(outcome).toEqual({ ok: false, reason: 'expired' });
  });

  it('never returns NaN as a volatility', () => {
    const prices = [0.0001, 0.01, 1, 5, 50, 99.9];
    for (const price of prices) {
      const outcome = impliedVolatility({ ...base, price });
      if (outcome.ok) {
        expect(Number.isNaN(outcome.result.volatility)).toBe(false);
        expect(outcome.result.volatility).toBeGreaterThan(0);
      }
    }
  });
});

describe('priceBounds', () => {
  it('bounds a call between discounted intrinsic and the discounted spot', () => {
    const b = priceBounds({
      spot: 100,
      strike: 90,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      right: 'call',
    });
    expect(b.lower).toBeCloseTo(100 - 90 * Math.exp(-0.05), 10);
    expect(b.upper).toBe(100);
  });

  it('bounds a put between discounted intrinsic and the discounted strike', () => {
    const b = priceBounds({
      spot: 100,
      strike: 110,
      timeToExpiry: 1,
      riskFreeRate: 0.05,
      right: 'put',
    });
    expect(b.lower).toBeCloseTo(110 * Math.exp(-0.05) - 100, 10);
    expect(b.upper).toBeCloseTo(110 * Math.exp(-0.05), 10);
  });

  it('never returns a negative lower bound', () => {
    const b = priceBounds({
      spot: 100,
      strike: 200,
      timeToExpiry: 0.5,
      riskFreeRate: 0.05,
      right: 'call',
    });
    expect(b.lower).toBe(0);
  });
});
