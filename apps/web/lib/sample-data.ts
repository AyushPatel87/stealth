/**
 * SYNTHETIC SAMPLE DATA - NOT MARKET DATA.
 *
 * Chains are priced by this project's own Black-Scholes engine. Nothing here
 * was observed in a market. The UI labels it as sample data on every screen,
 * and this module is never used as a fallback when a live provider fails.
 *
 * It exists so the interface can be developed and reviewed while the live data
 * path is unavailable, and produces both puts and calls so all four strategy
 * tabs have something to scan.
 */

import { blackScholes, expirationInstant, yearsToExpiry } from '@stealth/core';
import type { Bar, ContractSnapshot, OptionRight } from '@stealth/core';

const RISK_FREE = 0.045;

export interface SampleUnderlying {
  readonly symbol: string;
  readonly spot: number;
  readonly impliedVolatility: number;
}

export const SAMPLE_UNIVERSE: readonly SampleUnderlying[] = [
  { symbol: 'APP', spot: 462, impliedVolatility: 0.42 },
  { symbol: 'NVDA', spot: 178, impliedVolatility: 0.38 },
  { symbol: 'MU', spot: 121, impliedVolatility: 0.45 },
  { symbol: 'SNDK', spot: 64, impliedVolatility: 0.52 },
  { symbol: 'NBIS', spot: 39, impliedVolatility: 0.66 },
  { symbol: 'AMD', spot: 214, impliedVolatility: 0.4 },
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uptrending daily series ending at `spot`.
 *
 * Drift must dominate noise or the series does not actually trend and the
 * trend classifier correctly reports neutral for names meant to be rising.
 */
export function sampleBars(
  spot: number,
  days: number,
  seed: number,
  drift = 0.0028,
  vol = 0.011,
): Bar[] {
  const random = mulberry32(seed);
  const closes: number[] = [];
  let price = spot * 0.72;

  for (let i = 0; i < days; i += 1) {
    const u1 = Math.max(random(), 1e-9);
    const u2 = random();
    const shock = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    price *= 1 + drift + vol * shock;
    closes.push(price);
  }

  const scale = spot / (closes[closes.length - 1] as number);

  return closes.map((close, i) => {
    const c = close * scale;
    const range = c * 0.012;
    return {
      date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      open: c - range * 0.3,
      high: c + range,
      low: c - range,
      close: c,
      volume: 1_500_000 + Math.floor(random() * 2_000_000),
    };
  });
}

/**
 * Equity volatility skew.
 *
 * Real put chains are not priced at a single volatility: implied volatility
 * rises as strikes fall, because downside protection is bid up. Pricing a flat
 * surface made adjacent strikes differ by less than their own bid/ask spread,
 * so every generated credit spread came out below the minimum credit-to-width
 * floor and the PCS and CCS tabs returned nothing. That was the sample data
 * being unrepresentative, not the spread engine rejecting wrongly.
 *
 * A linear skew in moneyness is crude next to a real surface, but it restores
 * the property that actually matters here: strikes further out of the money
 * carry proportionally more premium than a flat surface implies.
 */
const SKEW_SLOPE = 0.9;

function skewedVolatility(
  atmVolatility: number,
  spot: number,
  strike: number,
): number {
  const moneyness = (spot - strike) / spot;
  return Math.max(0.03, atmVolatility * (1 + SKEW_SLOPE * moneyness));
}

/** Builds both puts and calls across a strike ladder around spot. */
export function sampleChain(
  underlying: SampleUnderlying,
  expirationIso: string,
  now: Date,
): ContractSnapshot[] {
  const expiration = expirationInstant(expirationIso);
  const years = yearsToExpiry(now, expiration);
  const { spot, impliedVolatility } = underlying;

  const step = spot > 300 ? 5 : spot > 100 ? 2.5 : 1;
  const lowest = Math.round((spot * 0.78) / step) * step;
  const highest = Math.round((spot * 1.22) / step) * step;

  const contracts: ContractSnapshot[] = [];
  const rights: OptionRight[] = ['put', 'call'];

  for (let strike = lowest; strike <= highest; strike += step) {
    for (const right of rights) {
      const contractIv = skewedVolatility(impliedVolatility, spot, strike);
      const priced = blackScholes({
        spot,
        strike,
        timeToExpiry: years,
        volatility: contractIv,
        riskFreeRate: RISK_FREE,
        right,
      });

      const theoretical = priced.price;
      if (theoretical < 0.03) continue;

      const otmFraction = Math.abs(spot - strike) / spot;
      const halfSpread = Math.max(0.01, theoretical * (0.006 + otmFraction * 0.12));
      const bid = Math.max(0.01, round2(theoretical - halfSpread));
      const ask = round2(theoretical + halfSpread);

      const nearness = Math.exp(-((otmFraction / 0.09) ** 2));
      contracts.push({
        occSymbol: `${underlying.symbol}${expirationIso.replace(/-/g, '').slice(2)}${
          right === 'put' ? 'P' : 'C'
        }${String(Math.round(strike * 1000)).padStart(8, '0')}`,
        strike,
        expiration,
        right,
        bid,
        ask,
        last: round2(theoretical),
        volume: Math.round(8 + 1200 * nearness),
        openInterest: Math.round(300 + 12000 * nearness),
        impliedVolatility: contractIv,
        delta: priced.delta,
        theta: priced.theta,
        vega: priced.vega,
      });
    }
  }

  return contracts;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
