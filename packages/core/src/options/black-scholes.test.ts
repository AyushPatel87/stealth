import { describe, expect, it } from 'vitest';
import {
  blackScholes,
  blackScholesPrice,
  rawGreeks,
  type BsmInputs,
  type OptionRight,
} from './black-scholes.js';

/**
 * Reference values were produced by an independently-written Python
 * implementation using `math.erfc` for the normal CDF. The Hull cases match the
 * worked examples in Hull, "Options, Futures and Other Derivatives"
 * (S=42, K=40, r=10%, sigma=20%, T=0.5 -> call 4.76, put 0.81).
 */
const REFERENCE = [
  {
    name: 'Hull 15.6 call',
    spot: 42,
    strike: 40,
    timeToExpiry: 0.5,
    volatility: 0.2,
    riskFreeRate: 0.1,
    dividendYield: 0.0,
    right: 'call' as const,
    price: 4.759422392872,
    delta: 0.779131290943,
    gamma: 0.049962670406,
    theta: -0.012490663547,
    vega: 0.088134150596,
    rho: 0.139820459134,
    probabilityItm: 0.734946036846,
  },
  {
    name: 'Hull 15.6 put',
    spot: 42,
    strike: 40,
    timeToExpiry: 0.5,
    volatility: 0.2,
    riskFreeRate: 0.1,
    dividendYield: 0.0,
    right: 'put' as const,
    price: 0.8085993729,
    delta: -0.220868709057,
    gamma: 0.049962670406,
    theta: -0.002066231498,
    vega: 0.088134150596,
    rho: -0.050425425767,
    probabilityItm: 0.265053963154,
  },
  {
    name: 'ATM 30d call',
    spot: 100,
    strike: 100,
    timeToExpiry: 0.0821917808219178,
    volatility: 0.25,
    riskFreeRate: 0.045,
    dividendYield: 0.0,
    right: 'call' as const,
    price: 3.041827957654,
    delta: 0.534839423047,
    gamma: 0.05544923745,
    theta: -0.05369255301,
    vega: 0.11393678928,
    rho: 0.041459272066,
    probabilityItm: 0.506290265177,
  },
  {
    name: 'CSP-like OTM put',
    spot: 462,
    strike: 440,
    timeToExpiry: 0.038356164383561646,
    volatility: 0.35,
    riskFreeRate: 0.045,
    dividendYield: 0.0,
    right: 'put' as const,
    price: 4.140892063068,
    delta: -0.220283805888,
    gamma: 0.009356695901,
    theta: -0.322077284326,
    vega: 0.268107943553,
    rho: -0.040623784805,
    probabilityItm: 0.241124943797,
  },
  {
    name: 'Covered-call strike with dividend yield',
    spot: 462,
    strike: 480,
    timeToExpiry: 0.038356164383561646,
    volatility: 0.32,
    riskFreeRate: 0.045,
    dividendYield: 0.015,
    right: 'call' as const,
    price: 5.039941804139,
    delta: 0.287515175961,
    gamma: 0.011770940034,
    theta: -0.362725789103,
    vega: 0.308375770703,
    rho: 0.049016136243,
    probabilityItm: 0.266693401187,
  },
  {
    name: 'Deep OTM put (tail accuracy)',
    spot: 100,
    strike: 60,
    timeToExpiry: 0.1232876712328767,
    volatility: 0.4,
    riskFreeRate: 0.045,
    dividendYield: 0.0,
    right: 'put' as const,
    // Full 17-significant-digit values. An earlier revision of this fixture
    // printed these with 12 DECIMAL places, which for magnitudes around 1e-5
    // retains only ~8 significant figures and manufactured a spurious ~1.7e-8
    // "failure" that looked like a tail-accuracy bug in the model. Keep full
    // precision for small-magnitude references.
    price: 0.00030922426569494205,
    delta: -8.9550205734034729e-5,
    gamma: 2.5407184431467026e-5,
    theta: -5.4544812403874504e-5,
    vega: 0.00012529570404559083,
    rho: -1.1421671719436401e-5,
    probabilityItm: 0.00015526308668647659,
  },
] as const;

function inputsOf(r: (typeof REFERENCE)[number]): BsmInputs {
  return {
    spot: r.spot,
    strike: r.strike,
    timeToExpiry: r.timeToExpiry,
    volatility: r.volatility,
    riskFreeRate: r.riskFreeRate,
    dividendYield: r.dividendYield,
    right: r.right,
  };
}

/** Relative comparison, so deep-OTM values (~1e-5) are judged fairly. */
function expectRelClose(actual: number, expected: number, tol = 1e-9): void {
  if (expected === 0) {
    expect(Math.abs(actual)).toBeLessThan(tol);
    return;
  }
  expect(Math.abs(actual / expected - 1)).toBeLessThan(tol);
}

describe('blackScholes - reference values', () => {
  for (const ref of REFERENCE) {
    it(`matches independent implementation: ${ref.name}`, () => {
      const tol = 1e-9;
      const r = blackScholes(inputsOf(ref));
      expectRelClose(r.price, ref.price, tol);
      expectRelClose(r.delta, ref.delta, tol);
      expectRelClose(r.gamma, ref.gamma, tol);
      expectRelClose(r.theta, ref.theta, tol);
      expectRelClose(r.vega, ref.vega, tol);
      expectRelClose(r.rho, ref.rho, tol);
      expectRelClose(r.probabilityItm, ref.probabilityItm, tol);
    });
  }

  it('reproduces the Hull textbook values to two decimals', () => {
    const call = blackScholesPrice({
      spot: 42,
      strike: 40,
      timeToExpiry: 0.5,
      volatility: 0.2,
      riskFreeRate: 0.1,
      right: 'call',
    });
    const put = blackScholesPrice({
      spot: 42,
      strike: 40,
      timeToExpiry: 0.5,
      volatility: 0.2,
      riskFreeRate: 0.1,
      right: 'put',
    });
    expect(call).toBeCloseTo(4.76, 2);
    expect(put).toBeCloseTo(0.81, 2);
  });
});

/**
 * Finite-difference verification. This is the test that actually catches an
 * algebra error in a Greek formula: it re-derives each sensitivity numerically
 * from the price function alone, so a wrong closed form cannot agree with it.
 */
describe('blackScholes - Greeks verified by finite difference', () => {
  const base: BsmInputs = {
    spot: 250,
    strike: 240,
    timeToExpiry: 45 / 365,
    volatility: 0.32,
    riskFreeRate: 0.045,
    dividendYield: 0.012,
    right: 'put',
  };

  const rights: readonly OptionRight[] = ['call', 'put'];

  for (const right of rights) {
    const inputs: BsmInputs = { ...base, right };
    const analytic = blackScholes(inputs);

    it(`delta matches central difference (${right})`, () => {
      const h = 1e-5 * inputs.spot;
      const numeric =
        (blackScholesPrice({ ...inputs, spot: inputs.spot + h }) -
          blackScholesPrice({ ...inputs, spot: inputs.spot - h })) /
        (2 * h);
      expect(analytic.delta).toBeCloseTo(numeric, 7);
    });

    it(`gamma matches second central difference (${right})`, () => {
      const h = 1e-3 * inputs.spot;
      const numeric =
        (blackScholesPrice({ ...inputs, spot: inputs.spot + h }) -
          2 * blackScholesPrice(inputs) +
          blackScholesPrice({ ...inputs, spot: inputs.spot - h })) /
        (h * h);
      // Second-order differences are inherently worse-conditioned than first
      // (truncation ~ h^2 and roundoff ~ eps/h^2 both bite), so relative
      // agreement is the meaningful bar rather than absolute.
      expect(Math.abs(analytic.gamma / numeric - 1)).toBeLessThan(1e-5);
    });

    it(`vega matches central difference, per volatility point (${right})`, () => {
      const h = 1e-6;
      const perUnitVol =
        (blackScholesPrice({
          ...inputs,
          volatility: inputs.volatility + h,
        }) -
          blackScholesPrice({
            ...inputs,
            volatility: inputs.volatility - h,
          })) /
        (2 * h);
      expect(analytic.vega).toBeCloseTo(perUnitVol / 100, 7);
    });

    it(`theta matches central difference, per calendar day (${right})`, () => {
      const h = 1e-6;
      // Theta is -dV/dT where T is time REMAINING.
      const perYear =
        -(
          blackScholesPrice({
            ...inputs,
            timeToExpiry: inputs.timeToExpiry + h,
          }) -
          blackScholesPrice({
            ...inputs,
            timeToExpiry: inputs.timeToExpiry - h,
          })
        ) /
        (2 * h);
      expect(analytic.theta).toBeCloseTo(perYear / 365, 6);
    });

    it(`rho matches central difference, per percentage point (${right})`, () => {
      const h = 1e-7;
      const perUnitRate =
        (blackScholesPrice({
          ...inputs,
          riskFreeRate: inputs.riskFreeRate + h,
        }) -
          blackScholesPrice({
            ...inputs,
            riskFreeRate: inputs.riskFreeRate - h,
          })) /
        (2 * h);
      expect(analytic.rho).toBeCloseTo(perUnitRate / 100, 6);
    });
  }
});

describe('blackScholes - structural invariants', () => {
  const S = 187.5;
  const K = 195;
  const T = 60 / 365;
  const sigma = 0.28;
  const r = 0.042;
  const q = 0.008;

  it('satisfies put-call parity: C - P = S*e^(-qT) - K*e^(-rT)', () => {
    const call = blackScholesPrice({
      spot: S,
      strike: K,
      timeToExpiry: T,
      volatility: sigma,
      riskFreeRate: r,
      dividendYield: q,
      right: 'call',
    });
    const put = blackScholesPrice({
      spot: S,
      strike: K,
      timeToExpiry: T,
      volatility: sigma,
      riskFreeRate: r,
      dividendYield: q,
      right: 'put',
    });
    const parity = S * Math.exp(-q * T) - K * Math.exp(-r * T);
    expect(call - put).toBeCloseTo(parity, 10);
  });

  it('gamma and vega are identical for calls and puts at the same strike', () => {
    const common = {
      spot: S,
      strike: K,
      timeToExpiry: T,
      volatility: sigma,
      riskFreeRate: r,
      dividendYield: q,
    };
    const call = blackScholes({ ...common, right: 'call' });
    const put = blackScholes({ ...common, right: 'put' });
    expect(call.gamma).toBeCloseTo(put.gamma, 15);
    expect(call.vega).toBeCloseTo(put.vega, 15);
  });

  it('keeps delta within its theoretical bounds across a wide grid', () => {
    for (const spot of [1, 50, 100, 150, 400]) {
      for (const vol of [0.05, 0.3, 1.5]) {
        for (const t of [1 / 365, 0.5, 2]) {
          const call = blackScholes({
            spot,
            strike: 100,
            timeToExpiry: t,
            volatility: vol,
            riskFreeRate: r,
            right: 'call',
          });
          const put = blackScholes({
            spot,
            strike: 100,
            timeToExpiry: t,
            volatility: vol,
            riskFreeRate: r,
            right: 'put',
          });
          expect(call.delta).toBeGreaterThanOrEqual(0);
          expect(call.delta).toBeLessThanOrEqual(1);
          expect(put.delta).toBeGreaterThanOrEqual(-1);
          expect(put.delta).toBeLessThanOrEqual(0);
          expect(call.gamma).toBeGreaterThanOrEqual(0);
          expect(call.vega).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('never prices an option below its intrinsic value discounted to the forward', () => {
    for (const spot of [80, 100, 130]) {
      const call = blackScholesPrice({
        spot,
        strike: 100,
        timeToExpiry: 0.25,
        volatility: 0.3,
        riskFreeRate: 0.05,
        right: 'call',
      });
      expect(call).toBeGreaterThanOrEqual(Math.max(spot - 100, 0) - 1e-9);
    }
  });

  it('price increases monotonically with volatility (vega > 0)', () => {
    let prev = -1;
    for (let vol = 0.05; vol <= 2; vol += 0.05) {
      const p = blackScholesPrice({
        spot: 100,
        strike: 110,
        timeToExpiry: 0.5,
        volatility: vol,
        riskFreeRate: 0.03,
        right: 'call',
      });
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('distinguishes probabilityItm from |delta|, in the correct direction for each right', () => {
    // Delta is widely used as a proxy for probability-ITM. It is not one, and
    // the bias has a definite sign that differs between calls and puts:
    //
    //   d1 = d2 + sigma*sqrt(T), so d1 > d2 always.
    //   call: P(ITM) = N(d2)  < N(d1)  ~ delta      -> delta OVERSTATES risk
    //   put:  P(ITM) = N(-d2) > N(-d1) ~ |delta|    -> delta UNDERSTATES risk
    //
    // The put case is the one that matters for cash-secured puts: screening on
    // 0.15 delta admits strikes whose true assignment probability is higher.
    const common = {
      spot: 462,
      strike: 440,
      timeToExpiry: 14 / 365,
      volatility: 0.35,
      riskFreeRate: 0.045,
    };

    const put = blackScholes({ ...common, right: 'put' });
    expect(put.probabilityItm).toBeGreaterThan(Math.abs(put.delta));

    const call = blackScholes({ ...common, strike: 480, right: 'call' });
    expect(call.probabilityItm).toBeLessThan(Math.abs(call.delta));

    // And neither is close enough to substitute for the other.
    expect(put.probabilityItm).not.toBeCloseTo(Math.abs(put.delta), 3);
  });

  it('has probabilityItm and probabilityOtm summing to 1', () => {
    const r3 = blackScholes({
      spot: 100,
      strike: 95,
      timeToExpiry: 0.25,
      volatility: 0.3,
      riskFreeRate: 0.04,
      right: 'put',
    });
    expect(r3.probabilityItm + r3.probabilityOtm).toBeCloseTo(1, 15);
  });
});

describe('blackScholes - degenerate and edge cases', () => {
  it('returns intrinsic value at expiry (T = 0)', () => {
    const itmPut = blackScholes({
      spot: 90,
      strike: 100,
      timeToExpiry: 0,
      volatility: 0.3,
      riskFreeRate: 0.05,
      right: 'put',
    });
    expect(itmPut.price).toBe(10);
    expect(itmPut.delta).toBe(-1);
    expect(itmPut.gamma).toBe(0);
    expect(itmPut.theta).toBe(0);
    expect(itmPut.vega).toBe(0);
    expect(itmPut.probabilityItm).toBe(1);

    const otmCall = blackScholes({
      spot: 90,
      strike: 100,
      timeToExpiry: 0,
      volatility: 0.3,
      riskFreeRate: 0.05,
      right: 'call',
    });
    expect(otmCall.price).toBe(0);
    expect(otmCall.delta).toBe(0);
    expect(otmCall.probabilityOtm).toBe(1);
  });

  it('treats negative time to expiry as expired rather than producing NaN', () => {
    const r = blackScholes({
      spot: 90,
      strike: 100,
      timeToExpiry: -0.5,
      volatility: 0.3,
      riskFreeRate: 0.05,
      right: 'put',
    });
    expect(Number.isFinite(r.price)).toBe(true);
    expect(r.price).toBe(10);
  });

  it('handles zero volatility as a deterministic forward, not NaN', () => {
    // Providers report iv = 0 for untraded strikes; this must not poison a scan.
    const r = blackScholes({
      spot: 100,
      strike: 90,
      timeToExpiry: 0.5,
      volatility: 0,
      riskFreeRate: 0.05,
      right: 'call',
    });
    const forward = 100 * Math.exp(0.05 * 0.5);
    expect(r.price).toBeCloseTo(Math.exp(-0.05 * 0.5) * (forward - 90), 10);
    expect(Number.isNaN(r.price)).toBe(false);
    expect(r.gamma).toBe(0);
    expect(r.vega).toBe(0);
  });

  it('handles zero volatility that finishes out of the money', () => {
    const r = blackScholes({
      spot: 100,
      strike: 200,
      timeToExpiry: 0.5,
      volatility: 0,
      riskFreeRate: 0.05,
      right: 'call',
    });
    expect(r.price).toBe(0);
    expect(r.delta).toBe(0);
  });

  it('treats negative volatility as degenerate rather than throwing', () => {
    const r = blackScholes({
      spot: 100,
      strike: 90,
      timeToExpiry: 0.5,
      volatility: -0.2,
      riskFreeRate: 0.05,
      right: 'call',
    });
    expect(Number.isFinite(r.price)).toBe(true);
  });

  it('does not overflow at extreme volatility', () => {
    const r = blackScholes({
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      volatility: 10,
      riskFreeRate: 0.05,
      right: 'call',
    });
    expect(Number.isFinite(r.price)).toBe(true);
    expect(r.price).toBeLessThanOrEqual(100);
  });

  it('does not overflow at very long expiries', () => {
    const r = blackScholes({
      spot: 100,
      strike: 100,
      timeToExpiry: 30,
      volatility: 0.3,
      riskFreeRate: 0.05,
      right: 'call',
    });
    expect(Number.isFinite(r.price)).toBe(true);
  });

  it('rejects non-positive spot and strike', () => {
    const bad: BsmInputs = {
      spot: 0,
      strike: 100,
      timeToExpiry: 0.5,
      volatility: 0.3,
      riskFreeRate: 0.05,
      right: 'call',
    };
    expect(() => blackScholes(bad)).toThrow(RangeError);
    expect(() => blackScholes({ ...bad, spot: -5 })).toThrow(RangeError);
    expect(() => blackScholes({ ...bad, spot: 100, strike: 0 })).toThrow(
      RangeError,
    );
  });

  it('rejects NaN inputs rather than silently returning NaN', () => {
    expect(() =>
      blackScholes({
        spot: Number.NaN,
        strike: 100,
        timeToExpiry: 0.5,
        volatility: 0.3,
        riskFreeRate: 0.05,
        right: 'call',
      }),
    ).toThrow(RangeError);
    expect(() =>
      blackScholes({
        spot: 100,
        strike: 100,
        timeToExpiry: 0.5,
        volatility: Number.NaN,
        riskFreeRate: 0.05,
        right: 'call',
      }),
    ).toThrow(RangeError);
  });
});

describe('rawGreeks', () => {
  it('undoes the display scaling exactly', () => {
    const inputs: BsmInputs = {
      spot: 120,
      strike: 115,
      timeToExpiry: 0.3,
      volatility: 0.29,
      riskFreeRate: 0.04,
      right: 'put',
    };
    const scaled = blackScholes(inputs);
    const raw = rawGreeks(inputs);
    expect(raw.theta).toBeCloseTo(scaled.theta * 365, 12);
    expect(raw.vega).toBeCloseTo(scaled.vega * 100, 12);
    expect(raw.rho).toBeCloseTo(scaled.rho * 100, 12);
    expect(raw.delta).toBe(scaled.delta);
    expect(raw.gamma).toBe(scaled.gamma);
  });
});
