/**
 * Covered call scanner.
 *
 * Supports both modes the specification calls for:
 *
 *   Mode A (holding)  A real position with a cost basis. Returns are measured
 *                     against what was actually paid, so "total return if
 *                     assigned" includes the capital gain or loss.
 *
 *   Mode B (universe) No position yet. Returns are measured against spot,
 *                     which answers a different question - is writing a call
 *                     against a NEW purchase attractive - and must not be
 *                     confused with the first.
 *
 * The distinction matters enough to be a required field rather than an option:
 * a call written 5% above a cost basis of $420 on a stock now at $462 is
 * assignment at a LOSS relative to the current price, and a scanner that
 * silently used spot for both would rank that as attractive.
 */

import {
  annualizedYield,
  blackScholes,
  calendarDte,
  distanceOtm,
  expectedMoveFromIv,
  premiumEstimate,
  premiumYield,
  shortOptionBreakeven,
  yearsToExpiry,
} from '../options/index.js';
import { regimeMultiplier, type RegimeBias } from '../regime/market-regime.js';
import {
  assembleScore,
  linear,
  pct,
  plateau,
  type RawComponent,
  type ScoreResult,
} from '../scoring/score.js';
import {
  DEFAULT_LIQUIDITY,
  type ContractSnapshot,
  type LiquidityFilterConfig,
  type Rejection,
  type ScanContext,
} from './types.js';

export interface CoveredCallWeights {
  readonly premiumIv: number;
  readonly upsideRoom: number;
  readonly delta: number;
  readonly technicalPosition: number;
  readonly trend: number;
  readonly liquidity: number;
  readonly marketRegime: number;
}

export const DEFAULT_CC_WEIGHTS: CoveredCallWeights = {
  premiumIv: 25,
  upsideRoom: 20,
  delta: 15,
  technicalPosition: 15,
  trend: 10,
  liquidity: 10,
  marketRegime: 5,
};

export interface CoveredCallConfig {
  readonly minDte: number;
  readonly maxDte: number;
  readonly minDelta: number;
  readonly maxDelta: number;
  readonly excludeEarnings: boolean;
  /** Reject strikes that would assign below cost basis (Mode A only). */
  readonly rejectAssignmentBelowBasis: boolean;
  readonly liquidity: LiquidityFilterConfig;
  readonly weights: CoveredCallWeights;
  readonly earningsRiskPenalty: number;
}

export const DEFAULT_CC_CONFIG: CoveredCallConfig = {
  minDte: 7,
  maxDte: 45,
  minDelta: 0.15,
  maxDelta: 0.35,
  excludeEarnings: true,
  rejectAssignmentBelowBasis: true,
  liquidity: DEFAULT_LIQUIDITY,
  weights: DEFAULT_CC_WEIGHTS,
  earningsRiskPenalty: 0.5,
};

export interface Holding {
  readonly shares: number;
  readonly costBasis: number;
}

export interface CoveredCallMetrics {
  readonly mode: 'holding' | 'universe';
  readonly dte: number;
  readonly strike: number;
  readonly premium: number;
  readonly delta: number;
  readonly impliedVolatility: number | null;
  readonly spreadPct: number | null;
  readonly distanceOtmPct: number;
  /** Capital base used for return calculations: cost basis or spot. */
  readonly capitalBase: number;
  readonly premiumYield: number;
  readonly annualizedYieldSimple: number;
  /** Per share. Negative when the strike sits below the cost basis. */
  readonly capitalGainIfAssigned: number;
  /** Premium plus capital gain, per share. */
  readonly totalGainIfAssigned: number;
  readonly totalReturnIfAssigned: number;
  readonly breakeven: number;
  /** Risk-neutral probability of finishing ITM, i.e. being called away. */
  readonly probabilityOfAssignment: number | null;
  readonly contracts: number | null;
  readonly premiumIncome: number | null;
  readonly expectedMove: number | null;
  readonly earningsBeforeExpiration: boolean;
}

export interface CoveredCallCandidate {
  readonly symbol: string;
  readonly contract: ContractSnapshot;
  readonly metrics: CoveredCallMetrics;
  readonly score: ScoreResult;
}

export type CoveredCallOutcome =
  | { readonly ok: true; readonly candidate: CoveredCallCandidate }
  | { readonly ok: false; readonly rejection: Rejection };

export function evaluateCoveredCall(
  contract: ContractSnapshot,
  context: ScanContext,
  holding: Holding | null = null,
  config: CoveredCallConfig = DEFAULT_CC_CONFIG,
  bias?: RegimeBias,
): CoveredCallOutcome {
  const reject = (
    reason: Rejection['reason'],
    detail: string,
  ): CoveredCallOutcome => ({ ok: false, rejection: { reason, detail } });

  if (contract.right !== 'call') {
    return reject('missing-data', 'Contract is not a call');
  }

  const dte = calendarDte(context.now, contract.expiration);
  if (dte < config.minDte || dte > config.maxDte) {
    return reject('dte-out-of-range', `${dte} DTE outside ${config.minDte}-${config.maxDte}`);
  }

  const premium = premiumEstimate({
    bid: contract.bid ?? undefined,
    ask: contract.ask ?? undefined,
    last: contract.last ?? undefined,
  });
  if (premium.source === 'unavailable' || premium.crossed) {
    return reject('no-premium', 'No usable two-sided quote');
  }
  const credit = premium.conservative ?? 0;
  if (credit <= 0) return reject('no-premium', 'Bid is zero');

  const absDelta = contract.delta === null ? null : Math.abs(contract.delta);
  if (absDelta === null) return reject('missing-data', 'No delta available');
  if (absDelta < config.minDelta || absDelta > config.maxDelta) {
    return reject(
      'delta-out-of-range',
      `Delta ${absDelta.toFixed(3)} outside ${config.minDelta}-${config.maxDelta}`,
    );
  }

  const earningsInside =
    context.earnings !== null &&
    earningsFallsBefore(context.earnings, contract.expiration);
  if (earningsInside && config.excludeEarnings) {
    return reject('earnings-before-expiration', 'Earnings before expiration');
  }

  if (
    contract.openInterest !== null &&
    contract.openInterest < config.liquidity.minOpenInterest
  ) {
    return reject('insufficient-open-interest', `OI ${contract.openInterest}`);
  }
  if (contract.volume !== null && contract.volume < config.liquidity.minVolume) {
    return reject('insufficient-volume', `Volume ${contract.volume}`);
  }
  if (
    premium.spreadPct !== null &&
    premium.spreadPct > config.liquidity.maxSpreadPct
  ) {
    return reject('spread-too-wide', `Spread ${pct(premium.spreadPct)}`);
  }

  const mode: 'holding' | 'universe' = holding === null ? 'universe' : 'holding';
  const capitalBase = holding === null ? context.spot : holding.costBasis;

  // Assignment below basis realises a loss on the shares that the premium may
  // not cover. Silently ranking that as attractive is the single worst failure
  // mode of a covered-call screener.
  if (
    holding !== null &&
    config.rejectAssignmentBelowBasis &&
    contract.strike < holding.costBasis
  ) {
    return reject(
      'strike-above-support',
      `Strike ${contract.strike} below cost basis ${holding.costBasis}`,
    );
  }

  const years = yearsToExpiry(context.now, contract.expiration);
  const iv = contract.impliedVolatility;

  let probabilityOfAssignment: number | null = null;
  if (iv !== null && iv > 0 && years > 0) {
    try {
      probabilityOfAssignment = blackScholes({
        spot: context.spot,
        strike: contract.strike,
        timeToExpiry: years,
        volatility: iv,
        riskFreeRate: context.riskFreeRate,
        dividendYield: context.dividendYield,
        right: 'call',
      }).probabilityItm;
    } catch {
      probabilityOfAssignment = null;
    }
  }

  const capitalGain = contract.strike - capitalBase;
  const totalGain = capitalGain + credit;
  const yieldOnBase = premiumYield(credit, capitalBase);
  const contracts = holding === null ? null : Math.floor(holding.shares / 100);

  const metrics: CoveredCallMetrics = {
    mode,
    dte,
    strike: contract.strike,
    premium: credit,
    delta: absDelta,
    impliedVolatility: iv,
    spreadPct: premium.spreadPct,
    distanceOtmPct: distanceOtm(context.spot, contract.strike, 'call'),
    capitalBase,
    premiumYield: yieldOnBase,
    annualizedYieldSimple: annualizedYield(yieldOnBase, Math.max(dte, 1)).simple,
    capitalGainIfAssigned: capitalGain,
    totalGainIfAssigned: totalGain,
    totalReturnIfAssigned: totalGain / capitalBase,
    breakeven: shortOptionBreakeven(capitalBase, credit, 'put'),
    probabilityOfAssignment,
    contracts,
    premiumIncome: contracts === null ? null : contracts * credit * 100,
    expectedMove:
      iv !== null && iv > 0
        ? expectedMoveFromIv(context.spot, iv, years).move
        : null,
    earningsBeforeExpiration: earningsInside,
  };

  const score = scoreCoveredCall(contract, context, metrics, config, bias);
  return { ok: true, candidate: { symbol: context.symbol, contract, metrics, score } };
}

function earningsFallsBefore(
  earnings: NonNullable<ScanContext['earnings']>,
  expiration: Date,
): boolean {
  const event = earnings.date.getTime();
  const expiry = expiration.getTime();
  if (event > expiry) return false;
  if (event < expiry) return true;
  return earnings.timing === 'before-open';
}

function scoreCoveredCall(
  contract: ContractSnapshot,
  context: ScanContext,
  metrics: CoveredCallMetrics,
  config: CoveredCallConfig,
  bias: RegimeBias | undefined,
): ScoreResult {
  const { weights } = config;
  const { technicals } = context;
  const raw: RawComponent[] = [];

  const yieldQuality = linear(metrics.annualizedYieldSimple, 0.05, 0.5);
  const richness = context.ivHv.ratio;
  const richnessQuality = richness === null ? null : linear(richness, 0.9, 1.6);
  raw.push({
    key: 'premiumIv',
    label: 'Premium / IV',
    weight: weights.premiumIv,
    quality:
      richnessQuality === null
        ? yieldQuality
        : 0.65 * yieldQuality + 0.35 * richnessQuality,
    detail:
      `${pct(metrics.annualizedYieldSimple)} annualised` +
      (richness === null ? '' : `, IV/HV ${richness.toFixed(2)}`),
    positive: 'Strong premium for the shares committed',
    negative: 'Premium is thin for the upside surrendered',
  });

  // Upside room: how much appreciation is kept before being called away.
  raw.push({
    key: 'upsideRoom',
    label: 'Upside Room',
    weight: weights.upsideRoom,
    quality: linear(metrics.distanceOtmPct, 0, 0.12),
    detail: `${pct(metrics.distanceOtmPct)} above spot`,
    positive: 'Meaningful room before assignment',
    negative: 'Strike close to spot, capping upside quickly',
  });

  raw.push({
    key: 'delta',
    label: 'Delta',
    weight: weights.delta,
    quality: plateau(
      metrics.delta,
      config.minDelta * 0.5,
      config.minDelta,
      config.maxDelta,
      config.maxDelta * 1.5,
    ),
    detail: `Delta ${metrics.delta.toFixed(3)}`,
    positive: 'Assignment probability in the target band',
    negative: 'Assignment probability outside the comfortable band',
  });

  // Strike above resistance is the desirable placement: the market has already
  // struggled there, so the shares are less likely to be called away.
  const resistance = technicals.resistance;
  raw.push({
    key: 'technicalPosition',
    label: 'Technical Position',
    weight: weights.technicalPosition,
    quality:
      resistance === null
        ? null
        : linear((contract.strike - resistance) / context.spot, -0.05, 0.04),
    detail:
      resistance === null
        ? 'No resistance level identified'
        : `Strike ${pct((contract.strike - resistance) / context.spot)} above resistance`,
    positive: 'Strike sits above recent resistance',
    negative: 'Strike sits below resistance, raising assignment odds',
  });

  const trendQuality = linear(technicals.trendScore, -100, 100);
  raw.push({
    key: 'trend',
    label: 'Trend',
    weight: weights.trend,
    // A covered call is short upside, so a violent uptrend is NOT ideal - the
    // shares get called away and the upside is forgone. Mild strength scores
    // best, which is why this is a plateau rather than a slope.
    quality: plateau(technicals.trendScore, -100, -10, 60, 110),
    detail: `Trend score ${technicals.trendScore.toFixed(0)}`,
    positive: 'Trend is steady rather than explosive',
    negative: 'Trend is strongly directional, which fits covered calls poorly',
  });

  const liquidityParts: number[] = [];
  const liquidityDetails: string[] = [];
  if (metrics.spreadPct !== null) {
    liquidityParts.push(linear(metrics.spreadPct, config.liquidity.maxSpreadPct, 0.01));
    liquidityDetails.push(`spread ${pct(metrics.spreadPct)}`);
  }
  if (contract.openInterest !== null) {
    liquidityParts.push(
      linear(contract.openInterest, config.liquidity.minOpenInterest, 5000),
    );
    liquidityDetails.push(`OI ${contract.openInterest}`);
  }
  raw.push({
    key: 'liquidity',
    label: 'Liquidity',
    weight: weights.liquidity,
    quality:
      liquidityParts.length === 0
        ? null
        : liquidityParts.reduce((a, b) => a + b, 0) / liquidityParts.length,
    detail: liquidityDetails.join(', ') || 'No liquidity data',
    positive: 'Liquid contract with a tight market',
    negative: 'Wide market or thin open interest',
  });

  raw.push({
    key: 'marketRegime',
    label: 'Market Regime',
    weight: weights.marketRegime,
    quality: regimeMultiplier(context.regime.label, 'CC', bias),
    detail: `Regime ${context.regime.label}`,
    positive: 'Market regime suits covered calls',
    negative: 'Market regime is unfavourable for covered calls',
  });

  const result = assembleScore(raw);
  if (!metrics.earningsBeforeExpiration) return result;

  const penalty = Math.min(Math.max(config.earningsRiskPenalty, 0), 1);
  return {
    ...result,
    score: Math.round(result.score * (1 - penalty) * 100) / 100,
    negativeFactors: ['Earnings before expiration', ...result.negativeFactors],
  };
}

export interface CoveredCallScanSummary {
  readonly candidates: readonly CoveredCallCandidate[];
  readonly examined: number;
  readonly rejections: Readonly<Record<string, number>>;
}

export function scanCoveredCalls(
  contracts: readonly ContractSnapshot[],
  context: ScanContext,
  holding: Holding | null = null,
  config: CoveredCallConfig = DEFAULT_CC_CONFIG,
  bias?: RegimeBias,
): CoveredCallScanSummary {
  const candidates: CoveredCallCandidate[] = [];
  const rejections: Record<string, number> = {};

  for (const contract of contracts) {
    const outcome = evaluateCoveredCall(contract, context, holding, config, bias);
    if (outcome.ok) candidates.push(outcome.candidate);
    else {
      rejections[outcome.rejection.reason] =
        (rejections[outcome.rejection.reason] ?? 0) + 1;
    }
  }

  candidates.sort((a, b) => b.score.score - a.score.score);
  return { candidates, examined: contracts.length, rejections };
}
