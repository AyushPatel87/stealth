import { describe, expect, it } from 'vitest';
import { enrichContract, enrichContracts } from './greeks-enricher';
import type { OptionContract } from './models';

const NOW = new Date('2026-08-07T20:00:00.000Z');
const EXPIRATION = new Date('2026-08-21T20:00:00.000Z');

function contract(overrides: Partial<OptionContract> = {}): OptionContract {
  return {
    occSymbol: 'TEST260821P00440000',
    underlyingSymbol: 'TEST',
    expiration: EXPIRATION,
    strike: 440,
    right: 'put',
    bid: 4.0,
    ask: 4.3,
    last: 4.15,
    volume: 120,
    openInterest: 3400,
    impliedVolatility: 0.35,
    greeks: null,
    greeksSource: 'unavailable',
    inTheMoney: false,
    lastTradeDate: null,
    ...overrides,
  };
}

const context = {
  spot: 462,
  now: NOW,
  riskFreeRate: 0.045,
  dividendYield: 0,
};

describe('enrichContract', () => {
  it('computes Greeks from provider implied volatility', () => {
    const result = enrichContract(contract(), context);

    expect(result.greeksSource).toBe('computed');
    expect(result.greeks).not.toBeNull();
    // A 440 put against a 462 spot at 35% IV, 14 DTE.
    expect(result.greeks?.delta).toBeCloseTo(-0.2203, 3);
    expect(result.greeks?.gamma).toBeGreaterThan(0);
    expect(result.greeks?.vega).toBeGreaterThan(0);
    expect(result.greeks?.theta).toBeLessThan(0);
  });

  it('never overwrites vendor-supplied Greeks', () => {
    // Vendor Greeks come from the vendor's own model. Replacing them silently
    // would make two providers' output incomparable in a way nothing
    // downstream could detect.
    const vendorGreeks = {
      delta: -0.11,
      gamma: 0.004,
      theta: -0.09,
      vega: 0.21,
      rho: -0.03,
    };
    const result = enrichContract(
      contract({ greeks: vendorGreeks, greeksSource: 'provider' }),
      context,
    );

    expect(result.greeks).toEqual(vendorGreeks);
    expect(result.greeksSource).toBe('provider');
  });

  it('marks contracts unavailable when there is no volatility to work from', () => {
    const result = enrichContract(
      contract({ impliedVolatility: null, bid: null, ask: null, last: null }),
      context,
    );
    expect(result.greeks).toBeNull();
    expect(result.greeksSource).toBe('unavailable');
  });

  it('treats a reported zero implied volatility as absent', () => {
    // Providers report iv: 0 for untraded strikes; using it would yield a
    // degenerate delta of exactly 0 or 1.
    const result = enrichContract(
      contract({ impliedVolatility: 0, bid: null, ask: null, last: null }),
      context,
    );
    expect(result.greeksSource).toBe('unavailable');
  });

  it('solves implied volatility from mid price when asked to', () => {
    const result = enrichContract(
      contract({ impliedVolatility: null }),
      { ...context, deriveMissingIv: true },
    );

    expect(result.greeksSource).toBe('computed');
    expect(result.impliedVolatility).not.toBeNull();
    expect(result.impliedVolatility as number).toBeGreaterThan(0.2);
    expect(result.impliedVolatility as number).toBeLessThan(0.6);
    expect(result.greeks?.delta).toBeLessThan(0);
  });

  it('does not derive implied volatility unless explicitly enabled', () => {
    const result = enrichContract(contract({ impliedVolatility: null }), context);
    expect(result.greeksSource).toBe('unavailable');
    expect(result.impliedVolatility).toBeNull();
  });

  it('falls back to last trade when deriving IV from a one-sided market', () => {
    const result = enrichContract(
      contract({ impliedVolatility: null, bid: null, ask: null, last: 4.15 }),
      { ...context, deriveMissingIv: true },
    );
    expect(result.greeksSource).toBe('computed');
  });

  it('handles an expired contract without producing NaN Greeks', () => {
    const result = enrichContract(
      contract({ expiration: new Date('2026-08-01T20:00:00.000Z') }),
      context,
    );
    expect(result.greeks).toBeNull();
    expect(result.greeksSource).toBe('unavailable');
  });

  it('degrades rather than throwing on a non-positive spot', () => {
    const result = enrichContract(contract(), { ...context, spot: 0 });
    expect(result.greeks).toBeNull();
    expect(result.greeksSource).toBe('unavailable');
  });

  it('applies dividend yield to the computation', () => {
    const withoutDividend = enrichContract(contract({ right: 'call', strike: 480 }), context);
    const withDividend = enrichContract(contract({ right: 'call', strike: 480 }), {
      ...context,
      dividendYield: 0.03,
    });
    // A dividend yield lowers a call's delta.
    expect(withDividend.greeks?.delta as number).toBeLessThan(
      withoutDividend.greeks?.delta as number,
    );
  });

  it('produces put deltas in [-1, 0] and call deltas in [0, 1]', () => {
    for (const strike of [380, 440, 462, 480, 560]) {
      const put = enrichContract(contract({ strike, right: 'put' }), context);
      const call = enrichContract(contract({ strike, right: 'call' }), context);
      expect(put.greeks?.delta as number).toBeLessThanOrEqual(0);
      expect(put.greeks?.delta as number).toBeGreaterThanOrEqual(-1);
      expect(call.greeks?.delta as number).toBeGreaterThanOrEqual(0);
      expect(call.greeks?.delta as number).toBeLessThanOrEqual(1);
    }
  });
});

describe('enrichContracts', () => {
  it('reports how much of the output rests on local modelling', () => {
    const contracts: OptionContract[] = [
      contract({ strike: 430 }),
      contract({ strike: 440 }),
      contract({
        strike: 450,
        greeks: { delta: -0.3, gamma: 0.01, theta: -0.2, vega: 0.3, rho: -0.05 },
        greeksSource: 'provider',
      }),
      contract({ strike: 460, impliedVolatility: null, bid: null, ask: null, last: null }),
    ];

    const { stats, contracts: enriched } = enrichContracts(contracts, context);

    expect(stats.total).toBe(4);
    expect(stats.computed).toBe(2);
    expect(stats.fromProvider).toBe(1);
    expect(stats.unavailable).toBe(1);
    expect(enriched).toHaveLength(4);
  });

  it('counts contracts whose IV was solved rather than supplied', () => {
    const contracts = [
      contract({ strike: 430, impliedVolatility: null }),
      contract({ strike: 440 }),
    ];
    const { stats } = enrichContracts(contracts, {
      ...context,
      deriveMissingIv: true,
    });
    expect(stats.ivDerived).toBe(1);
  });

  it('handles an empty chain', () => {
    const { stats, contracts } = enrichContracts([], context);
    expect(stats.total).toBe(0);
    expect(contracts).toEqual([]);
  });
});
