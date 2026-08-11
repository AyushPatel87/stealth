/**
 * Cash-secured put scanner.
 *
 * Filters first, then scores. The order matters: scoring is comparatively
 * expensive and most contracts in a chain fail a hard filter, so a scan over
 * ~375,000 contracts stays tractable by rejecting early.
 *
 * Rejections are typed and counted rather than dropped, so a scan returning
 * nothing can say why.
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

export interface CspWeights {
  readonly technicalPosition: number;
  readonly premiumIv: number;
  readonly delta: number;
  readonly supportDistance: number;
  readonly trend: number;
  readonly liquidity: number;
  readonly marketRegime: number;
}

/** Starting weights from the specification. Expected to be tuned, not fixed. */
export const DEFAULT_CSP_WEIGHTS: CspWeights = {
  technicalPosition: 25,
  premiumIv: 20,
  delta: 15,
  supportDistance: 15,
  trend: 10,
  liquidity: 10,
  marketRegime: 5,
};

export interface CspConfig {
  readonly minDte: number;
  readonly maxDte: number;
  readonly minDelta: number;
  readonly maxDelta: number;
  readonly minIvRank: number;
  readonly excludeEarnings: boolean;
  readonly requireAbove200Ema: boolean;
  readonly requireStrikeBelowSupport: boolean;
  readonly liquidity: LiquidityFilterConfig;
  readonly weights: CspWeights;
  /** Penalty multiplier applied when earnings are allowed but present. */
  readonly earningsRiskPenalty: number;
}

export const DEFAULT_CSP_CONFIG: CspConfig = {
  minDte: 7,
  maxDte: 30,
  minDelta: 0.05,
  maxDelta: 0.15,
  minIvRank: 30,
  excludeEarnings: true,
  requireAbove200Ema: true,
  requireStrikeBelowSupport: false,
  liquidity: DEFAULT_LIQUIDITY,
  weights: DEFAULT_CSP_WEIGHTS,
  earningsRiskPenalty: 0.5,
};

export interface CspMetrics {
  readonly dte: number;
  readonly strike: number;
  readonly premium: number;
  readonly premiumSource: 'bid-ask' | 'last-only';
  readonly mid: number | null;
  readonly spreadPct: number | null;
  readonly delta: number;
  readonly impliedVolatility: number | null;
  readonly distanceOtmPct: number;
  readonly premiumYield: number;
  readonly annualizedYieldSimple: number;
  readonly annualizedYieldCompounded: number;
  readonly breakeven: number;
  readonly collateral: number;
  readonly probabilityOtm: number | null;
  readonly expectedMove: number | null;
  readonly expectedMoveLower: number | null;
  /** Strike distance from spot in expected-move standard deviations. */
  readonly strikeSigmas: number | null;
  readonly earningsBeforeExpiration: boolean;
}

export interface CspCandidate {
  readonly symbol: string;
  readonly contract: ContractSnapshot;
  readonly metrics: CspMetrics;
  readonly score: ScoreResult;
}

export type CspOutcome =
  | { readonly ok: true; readonly candidate: CspCandidate }
  | { readonly ok: false; readonly rejection: Rejection };

/**
 * Whether the IV-Rank filter should apply.
 *
 * Disabled automatically until enough implied-volatility history has
 * accumulated. Without this the default `minIvRank: 30` would reject every
 * candidate on first run and the scanner would appear broken rather than
 * merely young.
 */
export function ivRankFilterActive(context: ScanContext): boolean {
  return context.ivRank.sufficient && context.ivRank.rank !== null;
}

export function evaluateCsp(
  contract: ContractSnapshot,
  context: ScanContext,
  config: CspConfig = DEFAULT_CSP_CONFIG,
  bias?: RegimeBias,
): CspOutcome {
  const reject = (reason: Rejection['reason'], detail: string): CspOutcome => ({
    ok: false,
    rejection: { reason, detail },
  });

  if (contract.right !== 'put') {
    return reject('missing-data', 'Contract is not a put');
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
  // Sellers receive the bid, not the mid. Using mid here would overstate every
  // yield, and most on the least liquid contracts.
  const credit = premium.conservative ?? 0;
  if (credit <= 0) {
    return reject('no-premium', 'Bid is zero');
  }

  const absDelta = contract.delta === null ? null : Math.abs(contract.delta);
  if (absDelta === null) {
    return reject('missing-data', 'No delta available');
  }
  if (absDelta < config.minDelta || absDelta > config.maxDelta) {
    return reject(
      'delta-out-of-range',
      `Delta ${absDelta.toFixed(3)} outside ${config.minDelta}-${config.maxDelta}`,
    );
  }

  if (
    ivRankFilterActive(context) &&
    (context.ivRank.rank as number) < config.minIvRank
  ) {
    return reject(
      'iv-rank-too-low',
      `IV Rank ${(context.ivRank.rank as number).toFixed(0)} below ${config.minIvRank}`,
    );
  }

  const earningsInside =
    context.earnings !== null &&
    earningsFallsBefore(context.earnings, contract.expiration);

  if (earningsInside && config.excludeEarnings) {
    return reject(
      'earnings-before-expiration',
      `Earnings ${context.earnings?.isEstimate ? '(estimated) ' : ''}before expiration`,
    );
  }

  const openInterest = contract.openInterest;
  if (openInterest !== null && openInterest < config.liquidity.minOpenInterest) {
    return reject(
      'insufficient-open-interest',
      `OI ${openInterest} below ${config.liquidity.minOpenInterest}`,
    );
  }
  const volume = contract.volume;
  if (volume !== null && volume < config.liquidity.minVolume) {
    return reject('insufficient-volume', `Volume ${volume} below ${config.liquidity.minVolume}`);
  }
  if (
    premium.spreadPct !== null &&
    premium.spreadPct > config.liquidity.maxSpreadPct
  ) {
    return reject(
      'spread-too-wide',
      `Spread ${pct(premium.spreadPct)} exceeds ${pct(config.liquidity.maxSpreadPct)}`,
    );
  }

  const { technicals } = context;
  if (
    config.requireAbove200Ema &&
    technicals.ema200 !== null &&
    context.spot <= technicals.ema200
  ) {
    return reject('below-200-ema', 'Price is below the 200 EMA');
  }
  if (
    config.requireStrikeBelowSupport &&
    technicals.support !== null &&
    contract.strike > technicals.support
  ) {
    return reject('strike-above-support', 'Strike sits above nearest support');
  }

  const metrics = buildMetrics(
    contract,
    context,
    dte,
    credit,
    premium.mid,
    premium.spreadPct,
    premium.source === 'bid-ask' ? 'bid-ask' : 'last-only',
    absDelta,
    earningsInside,
  );

  const score = scoreCsp(contract, context, metrics, config, bias);

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
  // Same instant: only a before-open report precedes settlement.
  return earnings.timing === 'before-open';
}

function buildMetrics(
  contract: ContractSnapshot,
  context: ScanContext,
  dte: number,
  credit: number,
  mid: number | null,
  spreadPct: number | null,
  premiumSource: 'bid-ask' | 'last-only',
  absDelta: number,
  earningsInside: boolean,
): CspMetrics {
  const years = yearsToExpiry(context.now, contract.expiration);
  const yieldOnCollateral = premiumYield(credit, contract.strike);
  const annualised = annualizedYield(yieldOnCollateral, Math.max(dte, 1));

  const iv = contract.impliedVolatility;
  const expectedMove =
    iv !== null && iv > 0 ? expectedMoveFromIv(context.spot, iv, years) : null;

  let probabilityOtm: number | null = null;
  if (iv !== null && iv > 0 && years > 0) {
    try {
      probabilityOtm = blackScholes({
        spot: context.spot,
        strike: contract.strike,
        timeToExpiry: years,
        volatility: iv,
        riskFreeRate: context.riskFreeRate,
        dividendYield: context.dividendYield,
        right: 'put',
      }).probabilityOtm;
    } catch {
      probabilityOtm = null;
    }
  }

  return {
    dte,
    strike: contract.strike,
    premium: credit,
    premiumSource,
    mid,
    spreadPct,
    delta: absDelta,
    impliedVolatility: iv,
    distanceOtmPct: distanceOtm(context.spot, contract.strike, 'put'),
    premiumYield: yieldOnCollateral,
    annualizedYieldSimple: annualised.simple,
    annualizedYieldCompounded: annualised.compounded,
    breakeven: shortOptionBreakeven(contract.strike, credit, 'put'),
    // Cash-secured: the broker holds strike x 100 per contract.
    collateral: contract.strike * 100,
    probabilityOtm,
    expectedMove: expectedMove?.move ?? null,
    expectedMoveLower: expectedMove?.lower ?? null,
    strikeSigmas:
      expectedMove && expectedMove.move > 0
        ? (contract.strike - context.spot) / expectedMove.move
        : null,
    earningsBeforeExpiration: earningsInside,
  };
}

function scoreCsp(
  contract: ContractSnapshot,
  context: ScanContext,
  metrics: CspMetrics,
  config: CspConfig,
  bias: RegimeBias | undefined,
): ScoreResult {
  const { weights } = config;
  const { technicals } = context;
  const raw: RawComponent[] = [];

  // --- Technical position -------------------------------------------------
  // Where the strike sits relative to structure: below the 200 EMA and deep
  // inside the 52-week range is the comfortable place for a short put.
  const technicalQuality = technicalPositionQuality(contract.strike, technicals);
  raw.push({
    key: 'technicalPosition',
    label: 'Technical Position',
    weight: weights.technicalPosition,
    quality: technicalQuality.quality,
    detail: technicalQuality.detail,
    positive: 'Strike well below key moving averages',
    negative: 'Strike sits close to or above key moving averages',
  });

  // --- Premium / IV -------------------------------------------------------
  // Annualised yield is the headline, but IV/HV decides whether that yield is
  // compensation for risk or just a high-volatility name being high-volatility.
  const yieldQuality = linear(metrics.annualizedYieldSimple, 0.05, 0.4);
  const richness = context.ivHv.ratio;
  const richnessQuality = richness === null ? null : linear(richness, 0.9, 1.6);
  const premiumQuality =
    richnessQuality === null
      ? yieldQuality
      : 0.6 * yieldQuality + 0.4 * richnessQuality;

  raw.push({
    key: 'premiumIv',
    label: 'Premium / IV',
    weight: weights.premiumIv,
    quality: premiumQuality,
    detail:
      `${pct(metrics.annualizedYieldSimple)} annualised` +
      (richness === null ? '' : `, IV/HV ${richness.toFixed(2)}`),
    positive: 'Attractive premium for the risk taken',
    negative: 'Thin premium relative to the capital committed',
  });

  // --- Delta --------------------------------------------------------------
  // A plateau, not a slope: too low earns nothing, too high courts assignment.
  const deltaQuality = plateau(
    metrics.delta,
    config.minDelta * 0.5,
    config.minDelta,
    config.maxDelta,
    config.maxDelta * 1.6,
  );
  raw.push({
    key: 'delta',
    label: 'Delta',
    weight: weights.delta,
    quality: deltaQuality,
    detail: `Delta ${metrics.delta.toFixed(3)}`,
    positive: 'Delta in the target band',
    negative: 'Delta outside the comfortable band',
  });

  // --- Support distance ---------------------------------------------------
  const supportQuality =
    technicals.support === null
      ? null
      : linear((technicals.support - contract.strike) / context.spot, -0.02, 0.06);
  raw.push({
    key: 'supportDistance',
    label: 'Support Distance',
    weight: weights.supportDistance,
    quality: supportQuality,
    detail:
      technicals.support === null
        ? 'No support level identified'
        : `Strike ${pct((technicals.support - contract.strike) / context.spot)} below support`,
    positive: 'Strike sits below recent support',
    negative: 'Strike sits above support, offering little cushion',
  });

  // --- Trend --------------------------------------------------------------
  // Incomplete trend data is damped rather than trusted at face value: a name
  // without a 200 EMA has not proven anything yet.
  const trendQuality = linear(technicals.trendScore, -100, 100);
  raw.push({
    key: 'trend',
    label: 'Trend',
    weight: weights.trend,
    quality: technicals.trendComplete ? trendQuality : trendQuality * 0.6,
    detail: technicals.trendComplete
      ? `Trend score ${technicals.trendScore.toFixed(0)}`
      : `Trend score ${technicals.trendScore.toFixed(0)} (incomplete history)`,
    positive: 'Underlying is in an uptrend',
    negative: 'Underlying trend is weak or negative',
  });

  // --- Liquidity ----------------------------------------------------------
  const liquidityQuality = liquidityScore(contract, metrics, config.liquidity);
  raw.push({
    key: 'liquidity',
    label: 'Liquidity',
    weight: weights.liquidity,
    quality: liquidityQuality.quality,
    detail: liquidityQuality.detail,
    positive: 'Liquid contract with a tight market',
    negative: 'Wide market or thin open interest',
  });

  // --- Market regime ------------------------------------------------------
  const multiplier = regimeMultiplier(context.regime.label, 'CSP', bias);
  raw.push({
    key: 'marketRegime',
    label: 'Market Regime',
    weight: weights.marketRegime,
    quality: multiplier,
    detail: `Regime ${context.regime.label}`,
    positive: 'Market regime favours put selling',
    negative: 'Market regime is unfavourable for put selling',
  });

  const result = assembleScore(raw);

  // Earnings inside the contract's life, when the user has opted to allow them,
  // is a whole-score penalty rather than a component: it is a risk of a
  // different kind from anything above, and should not be averaged away.
  if (metrics.earningsBeforeExpiration) {
    const penalty = Math.min(Math.max(config.earningsRiskPenalty, 0), 1);
    return {
      ...result,
      score: Math.round(result.score * (1 - penalty) * 100) / 100,
      negativeFactors: [
        `Earnings before expiration${context.earnings?.isEstimate ? ' (estimated date)' : ''}`,
        ...result.negativeFactors,
      ],
    };
  }

  return result;
}

function technicalPositionQuality(
  strike: number,
  technicals: ScanContext['technicals'],
): { quality: number | null; detail: string } {
  const references: number[] = [];
  if (technicals.ema50 !== null) references.push(technicals.ema50);
  if (technicals.ema200 !== null) references.push(technicals.ema200);

  if (references.length === 0) {
    return { quality: null, detail: 'No moving averages available' };
  }

  // Cushion to the nearest structural reference, as a fraction of price.
  const nearest = Math.min(...references.map((r) => (r - strike) / technicals.price));
  const quality = linear(nearest, -0.03, 0.1);

  return {
    quality,
    detail: `Strike ${pct(nearest)} below nearest key average`,
  };
}

function liquidityScore(
  contract: ContractSnapshot,
  metrics: CspMetrics,
  config: LiquidityFilterConfig,
): { quality: number | null; detail: string } {
  const parts: number[] = [];
  const details: string[] = [];

  if (metrics.spreadPct !== null) {
    parts.push(linear(metrics.spreadPct, config.maxSpreadPct, 0.01));
    details.push(`spread ${pct(metrics.spreadPct)}`);
  }
  if (contract.openInterest !== null) {
    parts.push(linear(contract.openInterest, config.minOpenInterest, 5000));
    details.push(`OI ${contract.openInterest}`);
  }
  if (contract.volume !== null) {
    parts.push(linear(contract.volume, config.minVolume, 500));
    details.push(`volume ${contract.volume}`);
  }

  if (parts.length === 0) {
    return { quality: null, detail: 'No liquidity data available' };
  }

  return {
    quality: parts.reduce((a, b) => a + b, 0) / parts.length,
    detail: details.join(', '),
  };
}

export interface CspScanSummary {
  readonly candidates: readonly CspCandidate[];
  readonly examined: number;
  /** Rejection counts by reason, so an empty scan can explain itself. */
  readonly rejections: Readonly<Record<string, number>>;
}

/** Evaluates a chain and returns ranked candidates plus rejection statistics. */
export function scanCsp(
  contracts: readonly ContractSnapshot[],
  context: ScanContext,
  config: CspConfig = DEFAULT_CSP_CONFIG,
  bias?: RegimeBias,
): CspScanSummary {
  const candidates: CspCandidate[] = [];
  const rejections: Record<string, number> = {};

  for (const contract of contracts) {
    const outcome = evaluateCsp(contract, context, config, bias);
    if (outcome.ok) {
      candidates.push(outcome.candidate);
    } else {
      const key = outcome.rejection.reason;
      rejections[key] = (rejections[key] ?? 0) + 1;
    }
  }

  candidates.sort((a, b) => b.score.score - a.score.score);

  return { candidates, examined: contracts.length, rejections };
}
