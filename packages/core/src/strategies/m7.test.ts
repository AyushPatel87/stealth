import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CC_CONFIG,
  evaluateCoveredCall,
  scanCoveredCalls,
} from './covered-call';
import {
  DEFAULT_SPREAD_CONFIG,
  evaluateCreditSpread,
  scanCreditSpreads,
} from './credit-spread';
import type { ContractSnapshot, ScanContext } from './types';
import { classifyMarketRegime } from '../regime/market-regime';
import { ivHvRatio, ivRank } from '../volatility/iv-rank';
import { blackScholes, yearsToExpiry } from '../options/index';

const NOW = new Date('2026-08-07T18:00:00.000Z');
const EXPIRATION = new Date('2026-08-21T20:00:00.000Z');

const bullish = classifyMarketRegime({
  spy: { price: 600, ema20: 595, ema50: 585, ema200: 550 },
  qqq: { price: 520, ema20: 515, ema50: 505, ema200: 470 },
  vix: { level: 14, change5d: -1 },
  breadth: 0.65,
});

function context(overrides: Partial<ScanContext> = {}): ScanContext {
  return {
    symbol: 'APP',
    now: NOW,
    spot: 462,
    riskFreeRate: 0.045,
    dividendYield: 0,
    technicals: {
      price: 462,
      ema20: 455,
      ema50: 448,
      ema200: 400,
      rsi14: 58,
      atrPercent14: 0.025,
      hv20: 0.28,
      support: 445,
      resistance: 475,
      week52High: 500,
      week52Low: 300,
      trendScore: 40,
      trendComplete: true,
    },
    ivRank: ivRank(0.38, []),
    ivHv: ivHvRatio(0.35, 0.28),
    earnings: null,
    regime: bullish,
    ...overrides,
  };
}

function call(overrides: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    occSymbol: 'APP260821C00480000',
    strike: 480,
    expiration: EXPIRATION,
    right: 'call',
    bid: 2.1,
    ask: 2.2,
    last: 2.15,
    volume: 300,
    openInterest: 2600,
    impliedVolatility: 0.34,
    delta: 0.22,
    theta: -0.08,
    vega: 0.25,
    ...overrides,
  };
}

function put(strike: number, delta: number, bid: number): ContractSnapshot {
  return {
    occSymbol: `APP260821P${String(strike * 1000).padStart(8, '0')}`,
    strike,
    expiration: EXPIRATION,
    right: 'put',
    bid,
    ask: Math.round((bid + 0.05) * 100) / 100,
    last: bid,
    volume: 200,
    openInterest: 1800,
    impliedVolatility: 0.35,
    delta: -delta,
    theta: -0.05,
    vega: 0.2,
  };
}

// ---------------------------------------------------------------------------
// Covered calls
// ---------------------------------------------------------------------------

describe('evaluateCoveredCall', () => {
  it('reproduces the specification worked example against a cost basis', () => {
    // APP, 100 shares at $420, spot $462, $480 call at $2.10, 14 DTE.
    const outcome = evaluateCoveredCall(call(), context(), {
      shares: 100,
      costBasis: 420,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const m = outcome.candidate.metrics;
    expect(m.mode).toBe('holding');
    expect(m.capitalBase).toBe(420);
    expect(m.premium).toBe(2.1);
    expect(m.contracts).toBe(1);
    expect(m.premiumIncome).toBeCloseTo(210, 6);
    expect(m.capitalGainIfAssigned).toBeCloseTo(60, 9);
    expect(m.totalGainIfAssigned).toBeCloseTo(62.1, 9);
    // $6,000 capital gain + $210 premium = $6,210 on 100 shares.
    expect(m.capitalGainIfAssigned * 100).toBeCloseTo(6000, 6);
    expect(m.totalGainIfAssigned * 100).toBeCloseTo(6210, 6);
  });

  it('measures against SPOT in universe mode, which is a different question', () => {
    const universe = evaluateCoveredCall(call(), context(), null);
    expect(universe.ok).toBe(true);
    if (!universe.ok) return;

    expect(universe.candidate.metrics.mode).toBe('universe');
    expect(universe.candidate.metrics.capitalBase).toBe(462);
    // Against spot the capital gain is only $18, not $60.
    expect(universe.candidate.metrics.capitalGainIfAssigned).toBeCloseTo(18, 9);
    expect(universe.candidate.metrics.contracts).toBeNull();
  });

  it('rejects a strike below the cost basis, which would assign at a loss', () => {
    // The worst failure mode of a covered-call screener: ranking a trade that
    // realises a loss on the shares as attractive because the premium looks good.
    const outcome = evaluateCoveredCall(
      call({ strike: 400, delta: 0.3 }),
      context(),
      { shares: 100, costBasis: 420 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.detail).toContain('below cost basis');
    }
  });

  it('computes probability of assignment from the model, not from delta', () => {
    const outcome = evaluateCoveredCall(call(), context(), null);
    if (!outcome.ok) return;
    const p = outcome.candidate.metrics.probabilityOfAssignment as number;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);

    // The point of this test is that assignment probability is N(d2) from the
    // model, NOT the delta the provider happened to report. Here the fixture's
    // delta (0.22) disagrees with the model's own view (~0.28 probability), and
    // the metric correctly follows the model rather than the fixture.
    expect(p).not.toBeCloseTo(outcome.candidate.metrics.delta, 2);

    // The N(d2) < delta relationship holds only when BOTH come from the same
    // parameters, so verify it against the model's own delta.
    const modelled = blackScholes({
      spot: 462,
      strike: 480,
      timeToExpiry: yearsToExpiry(NOW, EXPIRATION),
      volatility: 0.34,
      riskFreeRate: 0.045,
      right: 'call',
    });
    expect(modelled.probabilityItm).toBeLessThan(modelled.delta);
    expect(p).toBeCloseTo(modelled.probabilityItm, 9);
  });

  it('scores a steady trend above an explosive one', () => {
    // A covered call is short upside: a violent uptrend means the shares get
    // called away and the gain is forgone.
    const steady = evaluateCoveredCall(
      call(),
      context({ technicals: { ...context().technicals, trendScore: 30 } }),
      null,
    );
    const explosive = evaluateCoveredCall(
      call(),
      context({ technicals: { ...context().technicals, trendScore: 100 } }),
      null,
    );
    if (!steady.ok || !explosive.ok) throw new Error('expected both to pass');
    expect(steady.candidate.score.score).toBeGreaterThan(
      explosive.candidate.score.score,
    );
  });

  it('rejects puts, wrong DTE and illiquid contracts', () => {
    expect(evaluateCoveredCall(call({ right: 'put' }), context(), null).ok).toBe(false);
    expect(
      evaluateCoveredCall(
        call({ expiration: new Date('2026-12-18T21:00:00.000Z') }),
        context(),
        null,
      ).ok,
    ).toBe(false);
    expect(
      evaluateCoveredCall(call({ openInterest: 5 }), context(), null).ok,
    ).toBe(false);
  });

  it('produces a breakdown summing to the score', () => {
    const outcome = evaluateCoveredCall(call(), context(), null);
    if (!outcome.ok) return;
    const total = outcome.candidate.score.components.reduce(
      (sum, c) => sum + c.earned,
      0,
    );
    expect(total).toBeCloseTo(outcome.candidate.score.score, 1);
  });

  it('ranks a chain', () => {
    const summary = scanCoveredCalls(
      [call({ strike: 470, delta: 0.3 }), call({ strike: 480, delta: 0.22 }), call({ strike: 490, delta: 0.16 })],
      context(),
      null,
    );
    expect(summary.candidates.length).toBeGreaterThan(0);
    for (let i = 1; i < summary.candidates.length; i += 1) {
      expect(summary.candidates[i - 1]!.score.score).toBeGreaterThanOrEqual(
        summary.candidates[i]!.score.score,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Credit spreads
// ---------------------------------------------------------------------------

describe('evaluateCreditSpread - put credit spread', () => {
  it('reproduces the specification worked example', () => {
    // APP 450/445 put spread, roughly $0.82 credit on a $5 width.
    const outcome = evaluateCreditSpread(
      'put-credit',
      put(450, 0.12, 1.55),
      put(445, 0.09, 0.73),
      context(),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const m = outcome.candidate.metrics;
    expect(m.width).toBe(5);
    expect(m.shortStrike).toBe(450);
    expect(m.longStrike).toBe(445);
    // Short at bid 1.55, long at ask 0.78 -> credit 0.77.
    expect(m.credit).toBeCloseTo(0.77, 9);
    expect(m.maxLoss).toBeCloseTo(4.23, 9);
    expect(m.maxProfit + m.maxLoss).toBeCloseTo(m.width, 9);
    expect(m.breakeven).toBeCloseTo(449.23, 9);
    expect(m.collateral).toBeCloseTo(423, 6);
  });

  it('buys the long leg at the ask, not the mid', () => {
    // Using mid on both legs would inflate the credit on every spread, and most
    // on the widest markets.
    const outcome = evaluateCreditSpread(
      'put-credit',
      put(450, 0.12, 1.55),
      put(445, 0.09, 0.73),
      context(),
    );
    if (!outcome.ok) return;
    // Long ask is 0.78; a mid-based credit would have been 1.55 - 0.755 = 0.795.
    expect(outcome.candidate.metrics.credit).toBeLessThan(0.795);
  });

  it('rejects legs with different expirations', () => {
    const longLeg = {
      ...put(445, 0.09, 0.73),
      expiration: new Date('2026-08-28T20:00:00.000Z'),
    };
    const outcome = evaluateCreditSpread(
      'put-credit',
      put(450, 0.12, 1.55),
      longLeg,
      context(),
    );
    expect(outcome.ok).toBe(false);
  });

  it('rejects a credit too small relative to the width', () => {
    const outcome = evaluateCreditSpread(
      'put-credit',
      put(450, 0.12, 0.55),
      put(445, 0.11, 0.5),
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.reason).toBe('no-premium');
  });

  it('requires BOTH legs to be liquid', () => {
    // A tight short leg paired with an untradeable long leg is not a tradeable
    // spread.
    const illiquidLong = { ...put(445, 0.09, 0.73), openInterest: 3 };
    const outcome = evaluateCreditSpread(
      'put-credit',
      put(450, 0.12, 1.55),
      illiquidLong,
      context(),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.rejection.reason).toBe('insufficient-open-interest');
    }
  });

  it('computes probability of profit and expected value', () => {
    const outcome = evaluateCreditSpread(
      'put-credit',
      put(430, 0.1, 1.2),
      put(425, 0.08, 0.6),
      context(),
    );
    if (!outcome.ok) return;
    expect(outcome.candidate.metrics.probabilityOfProfit as number).toBeGreaterThan(0.5);
    expect(outcome.candidate.metrics.expectedValue).not.toBeNull();
  });
});

describe('evaluateCreditSpread - direction sensitivity', () => {
  it('scores a put spread higher in an uptrend and a call spread higher in a downtrend', () => {
    const up = context({ technicals: { ...context().technicals, trendScore: 90 } });
    const down = context({ technicals: { ...context().technicals, trendScore: -90 } });

    const pcsUp = evaluateCreditSpread('put-credit', put(450, 0.12, 1.55), put(445, 0.09, 0.73), up);
    const pcsDown = evaluateCreditSpread('put-credit', put(450, 0.12, 1.55), put(445, 0.09, 0.73), down);
    if (!pcsUp.ok || !pcsDown.ok) throw new Error('expected both to pass');
    expect(pcsUp.candidate.score.score).toBeGreaterThan(pcsDown.candidate.score.score);
  });

  it('handles call credit spreads with the strikes the other way round', () => {
    const shortCall = { ...call({ strike: 475, delta: 0.18 }), bid: 2.0, ask: 2.1 };
    const longCall = { ...call({ strike: 480, delta: 0.13 }), bid: 1.2, ask: 1.25 };
    const outcome = evaluateCreditSpread('call-credit', shortCall, longCall, context());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.candidate.metrics.kind).toBe('call-credit');
    expect(outcome.candidate.metrics.breakeven).toBeGreaterThan(475);
  });
});

describe('scanCreditSpreads', () => {
  const chain = [
    put(455, 0.16, 2.1),
    put(450, 0.12, 1.55),
    put(445, 0.09, 1.05),
    put(440, 0.07, 0.73),
    put(435, 0.05, 0.5),
  ];

  it('generates pairings at the allowed widths only', () => {
    const summary = scanCreditSpreads('put-credit', chain, context(), {
      ...DEFAULT_SPREAD_CONFIG,
      allowedWidths: [5],
    });
    expect(summary.examined).toBeGreaterThan(0);
    for (const candidate of summary.candidates) {
      expect(candidate.metrics.width).toBe(5);
    }
  });

  it('only pairs short legs inside the delta band', () => {
    const summary = scanCreditSpreads('put-credit', chain, context());
    for (const candidate of summary.candidates) {
      expect(candidate.metrics.shortDelta).toBeGreaterThanOrEqual(
        DEFAULT_SPREAD_CONFIG.minShortDelta,
      );
      expect(candidate.metrics.shortDelta).toBeLessThanOrEqual(
        DEFAULT_SPREAD_CONFIG.maxShortDelta,
      );
    }
  });

  it('ranks by score and counts rejections', () => {
    const summary = scanCreditSpreads('put-credit', chain, context());
    for (let i = 1; i < summary.candidates.length; i += 1) {
      expect(summary.candidates[i - 1]!.score.score).toBeGreaterThanOrEqual(
        summary.candidates[i]!.score.score,
      );
    }
    expect(typeof summary.rejections).toBe('object');
  });

  it('returns nothing for a chain with no valid pairings', () => {
    const summary = scanCreditSpreads('put-credit', [put(450, 0.12, 1.55)], context());
    expect(summary.candidates).toHaveLength(0);
  });

  it('produces breakdowns that sum to their scores', () => {
    const summary = scanCreditSpreads('put-credit', chain, context());
    for (const candidate of summary.candidates) {
      const total = candidate.score.components.reduce((s, c) => s + c.earned, 0);
      expect(total).toBeCloseTo(candidate.score.score, 1);
    }
  });
});
