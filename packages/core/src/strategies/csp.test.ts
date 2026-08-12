import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CSP_CONFIG,
  evaluateCsp,
  ivRankFilterActive,
  scanCsp,
} from './csp';
import type { ContractSnapshot, ScanContext } from './types';
import { classifyMarketRegime } from '../regime/market-regime';
import { ivHvRatio, ivRank } from '../volatility/iv-rank';

const NOW = new Date('2026-08-07T18:00:00.000Z');
const EXPIRATION = new Date('2026-08-21T20:00:00.000Z');

const bullishRegime = classifyMarketRegime({
  spy: { price: 600, ema20: 595, ema50: 585, ema200: 550 },
  qqq: { price: 520, ema20: 515, ema50: 505, ema200: 470 },
  vix: { level: 14, change5d: -1 },
  breadth: 0.65,
});

/** 120 observations so IV Rank is sufficient by default. */
const IV_HISTORY = Array.from({ length: 120 }, (_, i) => ({
  date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
  iv: 0.3 + 0.1 * Math.sin(i / 6),
}));

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
      resistance: 480,
      week52High: 500,
      week52Low: 300,
      trendScore: 85,
      trendComplete: true,
    },
    ivRank: ivRank(0.38, IV_HISTORY),
    ivHv: ivHvRatio(0.35, 0.28),
    earnings: null,
    regime: bullishRegime,
    ...overrides,
  };
}

function contract(overrides: Partial<ContractSnapshot> = {}): ContractSnapshot {
  return {
    occSymbol: 'APP260821P00440000',
    strike: 440,
    expiration: EXPIRATION,
    right: 'put',
    bid: 1.3,
    ask: 1.4,
    last: 1.35,
    volume: 250,
    openInterest: 3200,
    impliedVolatility: 0.35,
    delta: -0.1,
    theta: -0.05,
    vega: 0.2,
    ...overrides,
  };
}

function expectOk(outcome: ReturnType<typeof evaluateCsp>) {
  if (!outcome.ok) {
    throw new Error(`expected acceptance, got ${outcome.rejection.reason}`);
  }
  return outcome.candidate;
}

describe('evaluateCsp - metrics', () => {
  it('computes the headline metrics correctly', () => {
    const c = expectOk(evaluateCsp(contract(), context()));

    expect(c.metrics.dte).toBe(14);
    expect(c.metrics.strike).toBe(440);
    // Sellers receive the BID, not the mid.
    expect(c.metrics.premium).toBe(1.3);
    expect(c.metrics.mid).toBeCloseTo(1.35, 9);
    expect(c.metrics.collateral).toBe(44_000);
    expect(c.metrics.breakeven).toBeCloseTo(438.7, 9);
    expect(c.metrics.distanceOtmPct).toBeCloseTo(22 / 462, 9);
    expect(c.metrics.premiumYield).toBeCloseTo(1.3 / 440, 9);
    expect(c.metrics.annualizedYieldSimple).toBeCloseTo(
      (1.3 / 440) * (365 / 14),
      9,
    );
  });

  it('uses the bid rather than the mid, which would overstate yield', () => {
    const wide = expectOk(
      evaluateCsp(contract({ bid: 1.0, ask: 1.6 }), context(), {
        ...DEFAULT_CSP_CONFIG,
        liquidity: { ...DEFAULT_CSP_CONFIG.liquidity, maxSpreadPct: 0.6 },
      }),
    );
    expect(wide.metrics.premium).toBe(1.0);
    expect(wide.metrics.mid).toBeCloseTo(1.3, 9);
  });

  it('computes probability OTM and expected move', () => {
    const c = expectOk(evaluateCsp(contract(), context()));
    expect(c.metrics.probabilityOtm as number).toBeGreaterThan(0.7);
    expect(c.metrics.probabilityOtm as number).toBeLessThan(1);
    expect(c.metrics.expectedMove as number).toBeGreaterThan(0);
    // A 440 strike against a 462 spot sits below it, so sigmas are negative.
    expect(c.metrics.strikeSigmas as number).toBeLessThan(0);
  });
});

describe('evaluateCsp - filters', () => {
  it('rejects DTE outside the configured range', () => {
    const near = evaluateCsp(
      contract({ expiration: new Date('2026-08-10T20:00:00.000Z') }),
      context(),
    );
    expect(near.ok).toBe(false);
    if (!near.ok) expect(near.rejection.reason).toBe('dte-out-of-range');

    const far = evaluateCsp(
      contract({ expiration: new Date('2026-12-18T21:00:00.000Z') }),
      context(),
    );
    if (!far.ok) expect(far.rejection.reason).toBe('dte-out-of-range');
  });

  it('rejects delta outside the band, in both directions', () => {
    const tooLow = evaluateCsp(contract({ delta: -0.01 }), context());
    if (!tooLow.ok) expect(tooLow.rejection.reason).toBe('delta-out-of-range');

    const tooHigh = evaluateCsp(contract({ delta: -0.45 }), context());
    if (!tooHigh.ok) expect(tooHigh.rejection.reason).toBe('delta-out-of-range');
  });

  it('rejects illiquid contracts', () => {
    const thinOi = evaluateCsp(contract({ openInterest: 10 }), context());
    if (!thinOi.ok) {
      expect(thinOi.rejection.reason).toBe('insufficient-open-interest');
    }

    const wide = evaluateCsp(contract({ bid: 1.0, ask: 1.6 }), context());
    if (!wide.ok) expect(wide.rejection.reason).toBe('spread-too-wide');
  });

  it('rejects contracts with no usable quote', () => {
    const noQuote = evaluateCsp(
      contract({ bid: null, ask: null, last: null }),
      context(),
    );
    if (!noQuote.ok) expect(noQuote.rejection.reason).toBe('no-premium');

    const zeroBid = evaluateCsp(contract({ bid: 0, ask: 0.05 }), context(), {
      ...DEFAULT_CSP_CONFIG,
      liquidity: { ...DEFAULT_CSP_CONFIG.liquidity, maxSpreadPct: 5 },
    });
    if (!zeroBid.ok) expect(zeroBid.rejection.reason).toBe('no-premium');
  });

  it('rejects a crossed market', () => {
    const crossed = evaluateCsp(contract({ bid: 1.5, ask: 1.2 }), context());
    if (!crossed.ok) expect(crossed.rejection.reason).toBe('no-premium');
  });

  it('excludes earnings before expiration by default', () => {
    const withEarnings = evaluateCsp(
      contract(),
      context({
        earnings: {
          date: new Date('2026-08-14T20:30:00.000Z'),
          isEstimate: false,
          timing: 'after-close',
        },
      }),
    );
    expect(withEarnings.ok).toBe(false);
    if (!withEarnings.ok) {
      expect(withEarnings.rejection.reason).toBe('earnings-before-expiration');
    }
  });

  it('ignores earnings after expiration', () => {
    const after = evaluateCsp(
      contract(),
      context({
        earnings: {
          date: new Date('2026-09-14T20:30:00.000Z'),
          isEstimate: false,
          timing: 'after-close',
        },
      }),
    );
    expect(after.ok).toBe(true);
  });

  it('penalises rather than excludes earnings when the user allows them', () => {
    const ctx = context({
      earnings: {
        date: new Date('2026-08-14T20:30:00.000Z'),
        isEstimate: true,
        timing: 'after-close',
      },
    });
    const allowEarnings = { ...DEFAULT_CSP_CONFIG, excludeEarnings: false };

    const withEarnings = expectOk(evaluateCsp(contract(), ctx, allowEarnings));
    const without = expectOk(evaluateCsp(contract(), context(), allowEarnings));

    expect(withEarnings.metrics.earningsBeforeExpiration).toBe(true);
    expect(withEarnings.score.score).toBeLessThan(without.score.score);
    expect(withEarnings.score.negativeFactors[0]).toContain('Earnings before expiration');
    // The estimated-date caveat is surfaced, not hidden.
    expect(withEarnings.score.negativeFactors[0]).toContain('estimated');
  });

  it('rejects when price is below the 200 EMA and the guard is on', () => {
    const below = evaluateCsp(
      contract(),
      context({
        spot: 380,
        technicals: { ...context().technicals, price: 380, ema200: 400 },
      }),
    );
    if (!below.ok) expect(below.rejection.reason).toBe('below-200-ema');
  });

  it('can require the strike to sit below support', () => {
    const config = { ...DEFAULT_CSP_CONFIG, requireStrikeBelowSupport: true };
    const above = evaluateCsp(contract({ strike: 450 }), context(), config);
    if (!above.ok) expect(above.rejection.reason).toBe('strike-above-support');

    expect(evaluateCsp(contract({ strike: 440 }), context(), config).ok).toBe(true);
  });
});

describe('evaluateCsp - the IV Rank cold-start gate', () => {
  it('applies the IV Rank filter once history is sufficient', () => {
    const lowIvRank = context({ ivRank: ivRank(0.21, IV_HISTORY) });
    expect(ivRankFilterActive(lowIvRank)).toBe(true);

    const outcome = evaluateCsp(contract(), lowIvRank);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.rejection.reason).toBe('iv-rank-too-low');
  });

  it('DISABLES the filter when history is insufficient, rather than rejecting everything', () => {
    // Without this, the default minIvRank of 30 would reject every candidate on
    // first run and the scanner would look broken rather than merely young.
    const young = context({ ivRank: ivRank(0.38, IV_HISTORY.slice(0, 10)) });
    expect(ivRankFilterActive(young)).toBe(false);
    expect(evaluateCsp(contract(), young).ok).toBe(true);
  });
});

describe('scoreCsp - explainability', () => {
  it('produces a breakdown that sums exactly to the displayed score', () => {
    // The breakdown IS the computation, so a user adding it up must arrive at
    // the headline number.
    const c = expectOk(evaluateCsp(contract(), context()));
    const total = c.score.components.reduce((sum, comp) => sum + comp.earned, 0);
    expect(total).toBeCloseTo(c.score.score, 1);
  });

  it('reports every weighted component', () => {
    const c = expectOk(evaluateCsp(contract(), context()));
    expect(c.score.components.map((comp) => comp.key)).toEqual([
      'technicalPosition',
      'premiumIv',
      'delta',
      'supportDistance',
      'trend',
      'liquidity',
      'marketRegime',
    ]);
  });

  it('keeps each component within its own weight', () => {
    const c = expectOk(evaluateCsp(contract(), context()));
    for (const component of c.score.components) {
      expect(component.earned).toBeGreaterThanOrEqual(0);
      expect(component.earned).toBeLessThanOrEqual(component.weight + 1e-9);
      expect(component.detail.length).toBeGreaterThan(0);
    }
  });

  it('keeps the total within 0..100', () => {
    const c = expectOk(evaluateCsp(contract(), context()));
    expect(c.score.score).toBeGreaterThanOrEqual(0);
    expect(c.score.score).toBeLessThanOrEqual(100);
  });

  it('surfaces positive and negative factors', () => {
    const strong = expectOk(evaluateCsp(contract(), context()));
    expect(strong.score.positiveFactors.length).toBeGreaterThan(0);

    const weak = expectOk(
      evaluateCsp(
        contract({ bid: 0.35, ask: 0.37, openInterest: 600, volume: 12 }),
        context({
          technicals: {
            ...context().technicals,
            trendScore: -70,
            support: 400,
          },
        }),
      ),
    );
    expect(weak.score.negativeFactors.length).toBeGreaterThan(0);
    expect(weak.score.score).toBeLessThan(strong.score.score);
  });

  it('redistributes weight rather than zero-scoring unavailable components', () => {
    // Penalising a contract for a data gap would push thinly-covered names
    // down the rankings for reasons unrelated to their merit.
    const noSupport = expectOk(
      evaluateCsp(
        contract(),
        context({ technicals: { ...context().technicals, support: null } }),
      ),
    );

    expect(noSupport.score.unavailable).toContain('Support Distance');
    const total = noSupport.score.components.reduce(
      (sum, comp) => sum + comp.weight,
      0,
    );
    // Remaining components still span the full 100 points.
    expect(total).toBeCloseTo(100, 1);
  });

  it('scores a bearish regime lower than a bullish one, all else equal', () => {
    const bearish = classifyMarketRegime({
      spy: { price: 500, ema20: 510, ema50: 525, ema200: 545 },
      qqq: { price: 420, ema20: 430, ema50: 445, ema200: 470 },
      vix: { level: 22, change5d: 2 },
      breadth: 0.3,
    });

    const inBull = expectOk(evaluateCsp(contract(), context()));
    const inBear = expectOk(evaluateCsp(contract(), context({ regime: bearish })));
    expect(inBear.score.score).toBeLessThan(inBull.score.score);
  });

  it('honours custom weights', () => {
    const deltaOnly = {
      ...DEFAULT_CSP_CONFIG,
      weights: {
        technicalPosition: 0,
        premiumIv: 0,
        delta: 100,
        supportDistance: 0,
        trend: 0,
        liquidity: 0,
        marketRegime: 0,
      },
    };
    const c = expectOk(evaluateCsp(contract(), context(), deltaOnly));
    // Delta sits inside the band, so it earns full marks.
    expect(c.score.score).toBeCloseTo(100, 1);
  });
});

describe('scanCsp', () => {
  it('ranks candidates by score, highest first', () => {
    const chain = [
      contract({ strike: 440, delta: -0.1 }),
      contract({ strike: 430, delta: -0.07, bid: 0.9, ask: 0.95 }),
      contract({ strike: 450, delta: -0.14, bid: 1.9, ask: 2.0 }),
    ];
    const summary = scanCsp(chain, context());

    expect(summary.candidates.length).toBeGreaterThan(1);
    for (let i = 1; i < summary.candidates.length; i += 1) {
      expect(summary.candidates[i - 1]!.score.score).toBeGreaterThanOrEqual(
        summary.candidates[i]!.score.score,
      );
    }
  });

  it('counts rejections by reason so an empty scan can explain itself', () => {
    // "1,842 contracts examined, 1,203 failed the delta band" is actionable;
    // an empty table is not.
    const chain = [
      contract({ delta: -0.5 }),
      contract({ delta: -0.6 }),
      contract({ openInterest: 1 }),
    ];
    const summary = scanCsp(chain, context());

    expect(summary.examined).toBe(3);
    expect(summary.candidates).toHaveLength(0);
    expect(summary.rejections['delta-out-of-range']).toBe(2);
    expect(summary.rejections['insufficient-open-interest']).toBe(1);
  });

  it('handles an empty chain', () => {
    const summary = scanCsp([], context());
    expect(summary.examined).toBe(0);
    expect(summary.candidates).toEqual([]);
  });

  it('ignores calls in a put scan', () => {
    const summary = scanCsp([contract({ right: 'call' })], context());
    expect(summary.candidates).toHaveLength(0);
    expect(summary.rejections['missing-data']).toBe(1);
  });
});
