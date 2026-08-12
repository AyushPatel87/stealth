/**
 * Inputs the strategy scanners operate on.
 *
 * These are core's OWN shapes, not the data layer's. The scanners must not
 * depend on provider or database types, so the pipeline maps into these at the
 * boundary. Everything nullable is genuinely nullable in practice.
 */

import type { OptionRight } from '../options/black-scholes';
import type { RegimeAssessment } from '../regime/market-regime';
import type { IvHvRatioResult, IvRankResult } from '../volatility/iv-rank';

export interface ContractSnapshot {
  readonly occSymbol: string | null;
  readonly strike: number;
  readonly expiration: Date;
  readonly right: OptionRight;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;
  readonly impliedVolatility: number | null;
  readonly delta: number | null;
  readonly theta: number | null;
  readonly vega: number | null;
}

export interface TechnicalSnapshot {
  readonly price: number;
  readonly ema20: number | null;
  readonly ema50: number | null;
  readonly ema200: number | null;
  readonly rsi14: number | null;
  readonly atrPercent14: number | null;
  readonly hv20: number | null;
  readonly support: number | null;
  readonly resistance: number | null;
  readonly week52High: number | null;
  readonly week52Low: number | null;
  readonly trendScore: number;
  readonly trendComplete: boolean;
}

export interface EarningsSnapshot {
  readonly date: Date;
  readonly isEstimate: boolean;
  readonly timing: 'before-open' | 'after-close' | 'unknown';
}

export interface ScanContext {
  readonly symbol: string;
  readonly now: Date;
  readonly spot: number;
  readonly riskFreeRate: number;
  readonly dividendYield: number;
  readonly technicals: TechnicalSnapshot;
  readonly ivRank: IvRankResult;
  readonly ivHv: IvHvRatioResult;
  readonly earnings: EarningsSnapshot | null;
  readonly regime: RegimeAssessment;
}

/**
 * Why a candidate was excluded.
 *
 * Rejections are typed and counted rather than silently dropped, so a scan that
 * returns nothing can explain itself - "1,842 contracts examined, 1,203 failed
 * the delta band" is actionable, an empty table is not.
 */
export type RejectionReason =
  | 'dte-out-of-range'
  | 'delta-out-of-range'
  | 'iv-rank-too-low'
  | 'earnings-before-expiration'
  | 'insufficient-open-interest'
  | 'insufficient-volume'
  | 'spread-too-wide'
  | 'no-premium'
  | 'below-200-ema'
  | 'strike-above-support'
  | 'missing-data';

export interface Rejection {
  readonly reason: RejectionReason;
  readonly detail: string;
}

export interface LiquidityFilterConfig {
  readonly minOpenInterest: number;
  readonly minVolume: number;
  /** Maximum bid/ask spread as a fraction of mid. 0.10 = 10%. */
  readonly maxSpreadPct: number;
}

export const DEFAULT_LIQUIDITY: LiquidityFilterConfig = {
  minOpenInterest: 500,
  minVolume: 10,
  maxSpreadPct: 0.1,
};
