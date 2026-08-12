/**
 * Put and call credit spread scanner.
 *
 * Candidates are generated combinatorially: every eligible short strike paired
 * with every long strike at an allowed width, across the chain. That is O(n^2)
 * in strikes, so the width whitelist and an early short-leg filter do most of
 * the work in keeping a full-universe scan tractable.
 *
 * The two spread kinds share everything except direction, so they share an
 * implementation. Splitting them would duplicate the scoring logic and let the
 * two drift apart.
 */

import {
  approximateExpectedValue,
  calendarDte,
  distanceOtm,
  expectedMoveFromIv,
  premiumEstimate,
  probabilityOfProfit,
  verticalCreditSpread,
  yearsToExpiry,
  type SpreadKind,
  type VerticalSpreadMetrics,
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

export interface CreditSpreadWeights {
  readonly returnOnRisk: number;
  readonly probabilityOfProfit: number;
  readonly shortDelta: number;
  readonly technicalPosition: number;
  readonly liquidity: number;
  readonly trend: number;
  readonly marketRegime: number;
}

export const DEFAULT_SPREAD_WEIGHTS: CreditSpreadWeights = {
  returnOnRisk: 25,
  probabilityOfProfit: 20,
  shortDelta: 15,
  technicalPosition: 15,
  liquidity: 10,
  trend: 10,
  marketRegime: 5,
};

export interface CreditSpreadConfig {
  readonly minDte: number;
  readonly maxDte: number;
  readonly minShortDelta: number;
  readonly maxShortDelta: number;
  /** Permitted distances between strikes, in dollars. */
  readonly allowedWidths: readonly number[];
  /** Reject spreads whose credit is below this fraction of the width. */
  readonly minCreditToWidth: number;
  readonly excludeEarnings: boolean;
  readonly liquidity: LiquidityFilterConfig;
  readonly weights: CreditSpreadWeights;
  readonly earningsRiskPenalty: number;
}

export const DEFAULT_SPREAD_CONFIG: CreditSpreadConfig = {
  minDte: 7,
  maxDte: 45,
  minShortDelta: 0.08,
  maxShortDelta: 0.25,
  allowedWidths: [1, 2.5, 5, 10],
  // Below about a fifth of the width the risk/reward rarely justifies the
  // assignment and pin risk, however high the win probability looks.
  minCreditToWidth: 0.15,
  excludeEarnings: true,
  liquidity: { ...DEFAULT_LIQUIDITY, minOpenInterest: 250 },
  weights: DEFAULT_SPREAD_WEIGHTS,
  earningsRiskPenalty: 0.5,
};

export interface CreditSpreadMetrics {
  readonly kind: SpreadKind;
  readonly dte: number;
  readonly shortStrike: number;
  readonly longStrike: number;
  readonly width: number;
  readonly credit: number;
  readonly maxProfit: number;
  readonly maxLoss: number;
  readonly riskRewardRatio: number;
  readonly returnOnRisk: number;
  readonly breakeven: number;
  readonly collateral: number;
  readonly shortDelta: number;
  readonly distanceOtmPct: number;
  readonly probabilityOfProfit: number | null;
  readonly expectedValue: number | null;
  readonly expectedMove: number | null;
  readonly impliedVolatility: number | null;
  readonly worstSpreadPct: number | null;
  readonly minOpenInterest: number | null;
  readonly earningsBeforeExpiration: boolean;
}

export interface CreditSpreadCandidate {
  readonly symbol: string;
  readonly shortContract: ContractSnapshot;
  readonly longContract: ContractSnapshot;
  readonly metrics: CreditSpreadMetrics;
  readonly score: ScoreResult;
}

export type CreditSpreadOutcome =
  | { readonly ok: true; readonly candidate: CreditSpreadCandidate }
  | { readonly ok: false; readonly rejection: Rejection };

export function evaluateCreditSpread(
  kind: SpreadKind,
  shortContract: ContractSnapshot,
  longContract: ContractSnapshot,
  context: ScanContext,
  config: CreditSpreadConfig = DEFAULT_SPREAD_CONFIG,
  bias?: RegimeBias,
): CreditSpreadOutcome {
  const reject = (
    reason: Rejection['reason'],
    detail: string,
  ): CreditSpreadOutcome => ({ ok: false, rejection: { reason, detail } });

  const expectedRight = kind === 'put-credit' ? 'put' : 'call';
  if (shortContract.right !== expectedRight || longContract.right !== expectedRight) {
    return reject('missing-data', `Both legs must be ${expectedRight}s`);
  }
  if (shortContract.expiration.getTime() !== longContract.expiration.getTime()) {
    return reject('missing-data', 'Legs have different expirations');
  }

  const dte = calendarDte(context.now, shortContract.expiration);
  if (dte < config.minDte || dte > config.maxDte) {
    return reject('dte-out-of-range', `${dte} DTE outside range`);
  }

  const shortPremium = premiumEstimate({
    bid: shortContract.bid ?? undefined,
    ask: shortContract.ask ?? undefined,
    last: shortContract.last ?? undefined,
  });
  const longPremium = premiumEstimate({
    bid: longContract.bid ?? undefined,
    ask: longContract.ask ?? undefined,
    last: longContract.last ?? undefined,
  });

  if (
    shortPremium.source === 'unavailable' ||
    longPremium.source === 'unavailable' ||
    shortPremium.crossed ||
    longPremium.crossed
  ) {
    return reject('no-premium', 'One or both legs lack a usable quote');
  }

  // Realistic execution: sell the short leg at the bid, buy the long at the ask.
  // Using mid on both would inflate the credit on every spread, and most on the
  // widest markets.
  const shortCredit = shortPremium.conservative ?? 0;
  const longDebit = longPremium.mid === null ? 0 : (longContract.ask ?? longPremium.mid);

  const spread = verticalCreditSpread({
    kind,
    shortStrike: shortContract.strike,
    longStrike: longContract.strike,
    shortCredit,
    longDebit,
  });

  if (!spread.ok) {
    const reason: Rejection['reason'] =
      spread.reason === 'not-a-credit' || spread.reason === 'credit-exceeds-width'
        ? 'no-premium'
        : 'missing-data';
    return reject(reason, `Spread rejected: ${spread.reason}`);
  }

  const metricsBase = spread.metrics;

  if (metricsBase.netCredit / metricsBase.width < config.minCreditToWidth) {
    return reject(
      'no-premium',
      `Credit ${pct(metricsBase.netCredit / metricsBase.width)} of width, below minimum`,
    );
  }

  const shortDelta = shortContract.delta === null ? null : Math.abs(shortContract.delta);
  if (shortDelta === null) return reject('missing-data', 'No short-leg delta');
  if (shortDelta < config.minShortDelta || shortDelta > config.maxShortDelta) {
    return reject('delta-out-of-range', `Short delta ${shortDelta.toFixed(3)}`);
  }

  const earningsInside =
    context.earnings !== null &&
    earningsFallsBefore(context.earnings, shortContract.expiration);
  if (earningsInside && config.excludeEarnings) {
    return reject('earnings-before-expiration', 'Earnings before expiration');
  }

  // Both legs must be liquid: a tight short leg paired with an untradeable long
  // leg is not a tradeable spread.
  const openInterests = [shortContract.openInterest, longContract.openInterest].filter(
    (v): v is number => v !== null,
  );
  const minOi = openInterests.length > 0 ? Math.min(...openInterests) : null;
  if (minOi !== null && minOi < config.liquidity.minOpenInterest) {
    return reject('insufficient-open-interest', `Worst leg OI ${minOi}`);
  }

  const spreadPcts = [shortPremium.spreadPct, longPremium.spreadPct].filter(
    (v): v is number => v !== null,
  );
  const worstSpreadPct = spreadPcts.length > 0 ? Math.max(...spreadPcts) : null;
  if (worstSpreadPct !== null && worstSpreadPct > config.liquidity.maxSpreadPct) {
    return reject('spread-too-wide', `Worst leg spread ${pct(worstSpreadPct)}`);
  }

  const years = yearsToExpiry(context.now, shortContract.expiration);
  const iv = shortContract.impliedVolatility;

  let pop: number | null = null;
  if (iv !== null && iv > 0 && years > 0) {
    try {
      pop = probabilityOfProfit(metricsBase, {
        spot: context.spot,
        volatility: iv,
        yearsToExpiry: years,
        riskFreeRate: context.riskFreeRate,
        dividendYield: context.dividendYield,
      });
    } catch {
      pop = null;
    }
  }

  const metrics: CreditSpreadMetrics = {
    kind,
    dte,
    shortStrike: shortContract.strike,
    longStrike: longContract.strike,
    width: metricsBase.width,
    credit: metricsBase.netCredit,
    maxProfit: metricsBase.maxProfit,
    maxLoss: metricsBase.maxLoss,
    riskRewardRatio: metricsBase.riskRewardRatio,
    returnOnRisk: metricsBase.returnOnRisk,
    breakeven: metricsBase.breakeven,
    collateral: metricsBase.collateralPerContract,
    shortDelta,
    distanceOtmPct: distanceOtm(context.spot, shortContract.strike, expectedRight),
    probabilityOfProfit: pop,
    expectedValue: pop === null ? null : approximateExpectedValue(metricsBase, pop),
    expectedMove:
      iv !== null && iv > 0 ? expectedMoveFromIv(context.spot, iv, years).move : null,
    impliedVolatility: iv,
    worstSpreadPct,
    minOpenInterest: minOi,
    earningsBeforeExpiration: earningsInside,
  };

  const score = scoreCreditSpread(context, metrics, metricsBase, config, bias);

  return {
    ok: true,
    candidate: { symbol: context.symbol, shortContract, longContract, metrics, score },
  };
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

function scoreCreditSpread(
  context: ScanContext,
  metrics: CreditSpreadMetrics,
  base: VerticalSpreadMetrics,
  config: CreditSpreadConfig,
  bias: RegimeBias | undefined,
): ScoreResult {
  const { weights } = config;
  const { technicals } = context;
  const raw: RawComponent[] = [];

  raw.push({
    key: 'returnOnRisk',
    label: 'Return on Risk',
    weight: weights.returnOnRisk,
    quality: linear(metrics.returnOnRisk, 0.1, 0.45),
    detail: `${pct(metrics.returnOnRisk)} on $${metrics.maxLoss.toFixed(2)} risked`,
    positive: 'Healthy credit for the risk taken',
    negative: 'Credit is small relative to the width risked',
  });

  // Probability of profit alone is a trap: a 95% win rate on a 1:20 payoff is
  // negative expectancy. So the component is gated on expected value being
  // positive, which combines the two.
  const evPositive = metrics.expectedValue === null ? null : metrics.expectedValue > 0;
  raw.push({
    key: 'probabilityOfProfit',
    label: 'Probability of Profit',
    weight: weights.probabilityOfProfit,
    quality:
      metrics.probabilityOfProfit === null
        ? null
        : linear(metrics.probabilityOfProfit, 0.55, 0.9) *
          (evPositive === false ? 0.35 : 1),
    detail:
      metrics.probabilityOfProfit === null
        ? 'Probability unavailable'
        : `${pct(metrics.probabilityOfProfit, 0)} POP` +
          (metrics.expectedValue === null
            ? ''
            : `, EV $${metrics.expectedValue.toFixed(0)}`),
    positive: 'High probability of profit with positive expectancy',
    negative: 'Win rate does not compensate for the payoff asymmetry',
  });

  raw.push({
    key: 'shortDelta',
    label: 'Short-leg Delta',
    weight: weights.shortDelta,
    quality: plateau(
      metrics.shortDelta,
      config.minShortDelta * 0.5,
      config.minShortDelta,
      config.maxShortDelta,
      config.maxShortDelta * 1.5,
    ),
    detail: `Short delta ${metrics.shortDelta.toFixed(3)}`,
    positive: 'Short strike comfortably out of the money',
    negative: 'Short strike closer to the money than intended',
  });

  // For a put spread the relevant structure is support below; for a call
  // spread it is resistance above.
  const level =
    metrics.kind === 'put-credit' ? technicals.support : technicals.resistance;
  const cushion =
    level === null
      ? null
      : metrics.kind === 'put-credit'
        ? (level - metrics.shortStrike) / context.spot
        : (metrics.shortStrike - level) / context.spot;

  raw.push({
    key: 'technicalPosition',
    label: 'Technical Position',
    weight: weights.technicalPosition,
    quality: cushion === null ? null : linear(cushion, -0.03, 0.06),
    detail:
      cushion === null
        ? 'No structural level identified'
        : `Short strike ${pct(cushion)} beyond ${
            metrics.kind === 'put-credit' ? 'support' : 'resistance'
          }`,
    positive: 'Short strike sits beyond a structural level',
    negative: 'Short strike sits inside a structural level',
  });

  const liquidityParts: number[] = [];
  if (metrics.worstSpreadPct !== null) {
    liquidityParts.push(linear(metrics.worstSpreadPct, config.liquidity.maxSpreadPct, 0.02));
  }
  if (metrics.minOpenInterest !== null) {
    liquidityParts.push(
      linear(metrics.minOpenInterest, config.liquidity.minOpenInterest, 3000),
    );
  }
  raw.push({
    key: 'liquidity',
    label: 'Liquidity',
    weight: weights.liquidity,
    quality:
      liquidityParts.length === 0
        ? null
        : liquidityParts.reduce((a, b) => a + b, 0) / liquidityParts.length,
    detail:
      metrics.worstSpreadPct === null
        ? `worst-leg OI ${metrics.minOpenInterest ?? 'unknown'}`
        : `worst-leg spread ${pct(metrics.worstSpreadPct)}, OI ${metrics.minOpenInterest ?? '?'}`,
    positive: 'Both legs are liquid',
    negative: 'One leg is illiquid, making the spread hard to fill',
  });

  // A put credit spread wants strength; a call credit spread wants weakness.
  const trendQuality =
    metrics.kind === 'put-credit'
      ? linear(technicals.trendScore, -100, 100)
      : linear(technicals.trendScore, 100, -100);
  raw.push({
    key: 'trend',
    label: 'Trend',
    weight: weights.trend,
    quality: technicals.trendComplete ? trendQuality : trendQuality * 0.6,
    detail: `Trend score ${technicals.trendScore.toFixed(0)}`,
    positive: 'Underlying trend supports the spread direction',
    negative: 'Underlying trend works against the spread direction',
  });

  raw.push({
    key: 'marketRegime',
    label: 'Market Regime',
    weight: weights.marketRegime,
    quality: regimeMultiplier(
      context.regime.label,
      metrics.kind === 'put-credit' ? 'PCS' : 'CCS',
      bias,
    ),
    detail: `Regime ${context.regime.label}`,
    positive: 'Market regime supports this spread direction',
    negative: 'Market regime works against this spread direction',
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

export interface CreditSpreadScanSummary {
  readonly candidates: readonly CreditSpreadCandidate[];
  readonly examined: number;
  readonly rejections: Readonly<Record<string, number>>;
}

/**
 * Generates and evaluates every allowed leg pairing in a chain.
 *
 * The short leg is pre-filtered on delta before pairing, which turns the
 * combinatorial explosion into something proportional to the handful of strikes
 * actually in the target band.
 */
export function scanCreditSpreads(
  kind: SpreadKind,
  contracts: readonly ContractSnapshot[],
  context: ScanContext,
  config: CreditSpreadConfig = DEFAULT_SPREAD_CONFIG,
  bias?: RegimeBias,
): CreditSpreadScanSummary {
  const right = kind === 'put-credit' ? 'put' : 'call';
  const legs = contracts.filter((c) => c.right === right);
  const byStrike = new Map<number, ContractSnapshot>();
  for (const leg of legs) byStrike.set(leg.strike, leg);

  const candidates: CreditSpreadCandidate[] = [];
  const rejections: Record<string, number> = {};
  let examined = 0;

  for (const shortLeg of legs) {
    const delta = shortLeg.delta === null ? null : Math.abs(shortLeg.delta);
    if (delta === null || delta < config.minShortDelta || delta > config.maxShortDelta) {
      continue;
    }

    for (const width of config.allowedWidths) {
      const longStrike =
        kind === 'put-credit' ? shortLeg.strike - width : shortLeg.strike + width;
      const longLeg = byStrike.get(longStrike);
      if (!longLeg) continue;

      examined += 1;
      const outcome = evaluateCreditSpread(
        kind,
        shortLeg,
        longLeg,
        context,
        config,
        bias,
      );
      if (outcome.ok) candidates.push(outcome.candidate);
      else {
        rejections[outcome.rejection.reason] =
          (rejections[outcome.rejection.reason] ?? 0) + 1;
      }
    }
  }

  candidates.sort((a, b) => b.score.score - a.score.score);
  return { candidates, examined, rejections };
}
