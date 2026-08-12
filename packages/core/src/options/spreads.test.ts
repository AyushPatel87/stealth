import { describe, expect, it } from 'vitest';
import {
  approximateExpectedValue,
  probabilityOfProfit,
  verticalCreditSpread,
  type VerticalSpreadMetrics,
} from './spreads';

function unwrap(outcome: ReturnType<typeof verticalCreditSpread>) {
  if (!outcome.ok) {
    throw new Error(`expected a valid spread, got rejection: ${outcome.reason}`);
  }
  return outcome.metrics;
}

describe('verticalCreditSpread - put credit spread', () => {
  it('reproduces the worked example from the specification', () => {
    // APP 450/445 put spread, $0.82 credit, $5 wide, $4.18 max risk.
    const m = unwrap(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 450,
        longStrike: 445,
        shortCredit: 1.55,
        longDebit: 0.73,
      }),
    );

    expect(m.width).toBe(5);
    expect(m.netCredit).toBeCloseTo(0.82, 10);
    expect(m.maxProfit).toBeCloseTo(0.82, 10);
    expect(m.maxLoss).toBeCloseTo(4.18, 10);
    expect(m.breakeven).toBeCloseTo(449.18, 10);
    expect(m.maxProfitPerContract).toBeCloseTo(82, 8);
    expect(m.maxLossPerContract).toBeCloseTo(418, 8);
    expect(m.collateralPerContract).toBeCloseTo(418, 8);
  });

  it('computes risk/reward and return on risk as reciprocals', () => {
    const m = unwrap(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 450,
        longStrike: 445,
        shortCredit: 1.55,
        longDebit: 0.73,
      }),
    );
    expect(m.riskRewardRatio).toBeCloseTo(4.18 / 0.82, 10);
    expect(m.returnOnRisk).toBeCloseTo(0.82 / 4.18, 10);
    expect(m.riskRewardRatio * m.returnOnRisk).toBeCloseTo(1, 12);
  });

  it('places break-even below the short strike', () => {
    const m = unwrap(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 100,
        longStrike: 95,
        shortCredit: 1.2,
        longDebit: 0.4,
      }),
    );
    expect(m.breakeven).toBeLessThan(100);
    expect(m.breakeven).toBeCloseTo(99.2, 10);
  });

  it('always satisfies maxProfit + maxLoss == width', () => {
    for (const width of [1, 2.5, 5, 10]) {
      for (const credit of [0.1, 0.5, 0.9]) {
        const m = unwrap(
          verticalCreditSpread({
            kind: 'put-credit',
            shortStrike: 100,
            longStrike: 100 - width,
            shortCredit: credit * width,
            longDebit: 0,
          }),
        );
        expect(m.maxProfit + m.maxLoss).toBeCloseTo(width, 10);
      }
    }
  });
});

describe('verticalCreditSpread - call credit spread', () => {
  it('reproduces the worked example from the specification', () => {
    // APP 475/480 call spread, $0.75 credit, $4.25 max risk.
    const m = unwrap(
      verticalCreditSpread({
        kind: 'call-credit',
        shortStrike: 475,
        longStrike: 480,
        shortCredit: 2.0,
        longDebit: 1.25,
      }),
    );
    expect(m.width).toBe(5);
    expect(m.netCredit).toBeCloseTo(0.75, 10);
    expect(m.maxLoss).toBeCloseTo(4.25, 10);
    expect(m.breakeven).toBeCloseTo(475.75, 10);
  });

  it('places break-even above the short strike', () => {
    const m = unwrap(
      verticalCreditSpread({
        kind: 'call-credit',
        shortStrike: 100,
        longStrike: 105,
        shortCredit: 1.2,
        longDebit: 0.4,
      }),
    );
    expect(m.breakeven).toBeGreaterThan(100);
    expect(m.breakeven).toBeCloseTo(100.8, 10);
  });
});

describe('verticalCreditSpread - rejections', () => {
  it('rejects inverted strikes for a put credit spread', () => {
    // Short below long is a debit spread, not a credit spread.
    expect(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 445,
        longStrike: 450,
        shortCredit: 1.0,
        longDebit: 0.2,
      }),
    ).toEqual({ ok: false, reason: 'strikes-not-ordered' });
  });

  it('rejects inverted strikes for a call credit spread', () => {
    expect(
      verticalCreditSpread({
        kind: 'call-credit',
        shortStrike: 480,
        longStrike: 475,
        shortCredit: 1.0,
        longDebit: 0.2,
      }),
    ).toEqual({ ok: false, reason: 'strikes-not-ordered' });
  });

  it('rejects a zero-width spread', () => {
    expect(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 450,
        longStrike: 450,
        shortCredit: 1.0,
        longDebit: 0.2,
      }),
    ).toEqual({ ok: false, reason: 'zero-width' });
  });

  it('rejects a net debit', () => {
    expect(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 450,
        longStrike: 445,
        shortCredit: 0.5,
        longDebit: 0.9,
      }),
    ).toEqual({ ok: false, reason: 'not-a-credit' });
  });

  it('rejects a credit exceeding the width instead of reporting free money', () => {
    // This is the guard that matters most: a stale quote on one leg would
    // otherwise yield negative max loss and an infinite return on risk, which
    // would pin the spread permanently at the top of the rankings.
    const outcome = verticalCreditSpread({
      kind: 'put-credit',
      shortStrike: 450,
      longStrike: 445,
      shortCredit: 6.0,
      longDebit: 0.2,
    });
    expect(outcome).toEqual({ ok: false, reason: 'credit-exceeds-width' });
  });

  it('rejects a credit exactly equal to the width', () => {
    expect(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 450,
        longStrike: 445,
        shortCredit: 5.0,
        longDebit: 0,
      }),
    ).toEqual({ ok: false, reason: 'credit-exceeds-width' });
  });

  it('rejects malformed numeric input', () => {
    const bad = {
      kind: 'put-credit' as const,
      shortStrike: 450,
      longStrike: 445,
      shortCredit: 1.0,
      longDebit: 0.2,
    };
    expect(verticalCreditSpread({ ...bad, shortStrike: Number.NaN })).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(verticalCreditSpread({ ...bad, shortStrike: -450 })).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(verticalCreditSpread({ ...bad, longDebit: -1 })).toEqual({
      ok: false,
      reason: 'invalid-input',
    });
    expect(
      verticalCreditSpread({ ...bad, contractMultiplier: 0 }),
    ).toEqual({ ok: false, reason: 'invalid-input' });
  });

  it('supports a non-standard contract multiplier', () => {
    const m = unwrap(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 450,
        longStrike: 445,
        shortCredit: 1.55,
        longDebit: 0.73,
        contractMultiplier: 10,
      }),
    );
    expect(m.maxProfitPerContract).toBeCloseTo(8.2, 8);
    expect(m.maxLossPerContract).toBeCloseTo(41.8, 8);
  });
});

describe('probabilityOfProfit', () => {
  const pcs = unwrap(
    verticalCreditSpread({
      kind: 'put-credit',
      shortStrike: 450,
      longStrike: 445,
      shortCredit: 1.55,
      longDebit: 0.73,
    }),
  );

  const marketInputs = {
    spot: 462,
    volatility: 0.35,
    yearsToExpiry: 14 / 365,
    riskFreeRate: 0.045,
  };

  it('returns a probability in [0, 1]', () => {
    const p = probabilityOfProfit(pcs, marketInputs);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it('agrees with a hand-computed sigma distance', () => {
    // Worth stating plainly, because "450 short strike against a 462 spot"
    // reads as comfortably far out of the money and is not: at 35% IV over 14
    // days the expected move is +/- $31.70, so the $449.18 break-even sits only
    // 0.40 sigma below spot. Probability of profit is therefore ~N(0.40) ~ 0.66,
    // NOT the ~0.85 that the 0.12-ish short delta might suggest.
    const expectedMove = 462 * 0.35 * Math.sqrt(14 / 365);
    const sigmas = (462 - pcs.breakeven) / expectedMove;
    expect(expectedMove).toBeCloseTo(31.7, 1);
    expect(sigmas).toBeCloseTo(0.4, 1);

    const p = probabilityOfProfit(pcs, marketInputs);
    expect(p).toBeGreaterThan(0.6);
    expect(p).toBeLessThan(0.7);
  });

  it('is high for a genuinely far out-of-the-money spread', () => {
    const farOtm = unwrap(
      verticalCreditSpread({
        kind: 'put-credit',
        shortStrike: 380,
        longStrike: 375,
        shortCredit: 0.6,
        longDebit: 0.35,
      }),
    );
    // ~2.6 sigma below spot.
    expect(probabilityOfProfit(farOtm, marketInputs)).toBeGreaterThan(0.95);
  });

  it('measures from break-even, not the short strike', () => {
    // The credit cushions the position, so probability measured at break-even
    // must exceed probability measured at the short strike. Conflating them
    // understates every credit spread in the rankings.
    const atBreakeven = probabilityOfProfit(pcs, marketInputs);
    const atShortStrike = probabilityOfProfit(
      { ...pcs, breakeven: pcs.width > 0 ? 450 : 450 } as VerticalSpreadMetrics,
      marketInputs,
    );
    expect(atBreakeven).toBeGreaterThan(atShortStrike);
  });

  it('falls as the underlying approaches the short strike', () => {
    const far = probabilityOfProfit(pcs, { ...marketInputs, spot: 520 });
    const near = probabilityOfProfit(pcs, { ...marketInputs, spot: 455 });
    expect(far).toBeGreaterThan(near);
  });

  it('mirrors correctly for a call credit spread', () => {
    const ccs = unwrap(
      verticalCreditSpread({
        kind: 'call-credit',
        shortStrike: 475,
        longStrike: 480,
        shortCredit: 2.0,
        longDebit: 1.25,
      }),
    );
    // Underlying well below the short call: very likely to expire worthless.
    const p = probabilityOfProfit(ccs, { ...marketInputs, spot: 420 });
    expect(p).toBeGreaterThan(0.9);
    // Underlying well above: very likely a loser.
    const q = probabilityOfProfit(ccs, { ...marketInputs, spot: 520 });
    expect(q).toBeLessThan(0.1);
  });

  it('approaches certainty as volatility approaches zero', () => {
    const p = probabilityOfProfit(pcs, {
      ...marketInputs,
      volatility: 0.0001,
    });
    expect(p).toBeGreaterThan(0.999);
  });
});

describe('approximateExpectedValue', () => {
  const pcs = unwrap(
    verticalCreditSpread({
      kind: 'put-credit',
      shortStrike: 450,
      longStrike: 445,
      shortCredit: 1.55,
      longDebit: 0.73,
    }),
  );

  it('is positive when the win probability outweighs the payoff asymmetry', () => {
    // Needs p > maxLoss / (maxProfit + maxLoss) = 4.18/5 = 0.836 to break even.
    expect(approximateExpectedValue(pcs, 0.95)).toBeGreaterThan(0);
    expect(approximateExpectedValue(pcs, 0.7)).toBeLessThan(0);
  });

  it('crosses zero exactly at the break-even probability', () => {
    const breakEvenProbability = pcs.maxLoss / (pcs.maxProfit + pcs.maxLoss);
    expect(approximateExpectedValue(pcs, breakEvenProbability)).toBeCloseTo(
      0,
      8,
    );
  });

  it('clamps probabilities outside [0, 1]', () => {
    expect(approximateExpectedValue(pcs, 1.5)).toBeCloseTo(
      pcs.maxProfitPerContract,
      8,
    );
    expect(approximateExpectedValue(pcs, -0.5)).toBeCloseTo(
      -pcs.maxLossPerContract,
      8,
    );
  });

  it('shows that a high win rate can still be negative expectancy', () => {
    // The classic premium-selling trap: 80% win rate on a 1:5 payoff loses.
    expect(approximateExpectedValue(pcs, 0.8)).toBeLessThan(0);
  });
});
