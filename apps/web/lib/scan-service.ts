/**
 * Server-side scan service.
 *
 * Runs on the server only. The browser never calls a provider and never
 * performs a financial calculation - it receives finished, ranked opportunities
 * and renders them.
 *
 * This is a deliberate interim shape. Once the worker and database land (M8),
 * this module reads persisted scan results instead of scanning inline; the
 * component layer above it does not change, because it already depends only on
 * the view models defined here.
 */

import 'server-only';

import {
  DEFAULT_CC_CONFIG,
  DEFAULT_CSP_CONFIG,
  DEFAULT_SPREAD_CONFIG,
  classifyMarketRegime,
  computeIndicators,
  ivHvRatio,
  ivRank,
  scanCoveredCalls,
  scanCreditSpreads,
  scanCsp,
  volatilityRichnessLabel,
  type Bar,
  type ContractSnapshot,
  type RegimeAssessment,
  type ScanContext,
  type ScoreResult,
} from '@stealth/core';
import {
  SAMPLE_UNIVERSE,
  sampleBars,
  sampleChain,
} from './sample-data';

export type StrategyTab = 'CSP' | 'CC' | 'PCS' | 'CCS';

/**
 * One row in the scanner grid, flattened so the client component needs no
 * knowledge of strategy-specific shapes.
 */
export interface OpportunityRow {
  readonly id: string;
  readonly strategy: StrategyTab;
  readonly symbol: string;
  readonly label: string;
  readonly expiration: string;
  readonly dte: number;
  readonly score: number;
  readonly delta: number;
  readonly premium: number;
  readonly distanceOtmPct: number;
  readonly annualizedYield: number | null;
  readonly probability: number | null;
  readonly openInterest: number | null;
  readonly spreadPct: number | null;
  /** Risk capital committed per contract. */
  readonly collateral: number;
  readonly breakdown: ScoreResult;
  readonly ladder: readonly LadderLevel[];
  readonly notes: readonly string[];
}

export interface LadderLevel {
  readonly price: number;
  readonly label: string;
  readonly kind: 'spot' | 'strike' | 'band' | 'breakeven' | 'level';
}

export interface ScanResult {
  readonly rows: readonly OpportunityRow[];
  readonly regime: RegimeAssessment;
  readonly examined: number;
  readonly rejections: Readonly<Record<string, number>>;
  readonly generatedAt: string;
  readonly mode: 'sample' | 'live';
  /** Populated when a live scan failed; the UI must show this, not hide it. */
  readonly error: string | null;
  readonly marketTape: readonly TapeEntry[];
}

export interface TapeEntry {
  readonly label: string;
  readonly value: string;
  readonly tone: 'neutral' | 'good' | 'bad';
}

function ladderFor(
  spot: number,
  strike: number,
  breakeven: number,
  expectedMove: number | null,
  strikeLabel: string,
): LadderLevel[] {
  const levels: LadderLevel[] = [
    { price: spot, label: 'Current price', kind: 'spot' },
    { price: strike, label: strikeLabel, kind: 'strike' },
    { price: breakeven, label: 'Break-even', kind: 'breakeven' },
  ];
  if (expectedMove !== null && expectedMove > 0) {
    levels.push(
      { price: spot + expectedMove, label: 'Expected move +1σ', kind: 'band' },
      { price: spot - expectedMove, label: 'Expected move −1σ', kind: 'band' },
    );
  }
  return levels.sort((a, b) => b.price - a.price);
}

interface SymbolInput {
  readonly symbol: string;
  readonly spot: number;
  readonly bars: readonly Bar[];
  readonly contracts: readonly ContractSnapshot[];
  readonly atmIv: number;
}

function buildContext(
  input: SymbolInput,
  now: Date,
  regime: RegimeAssessment,
): ScanContext {
  const indicators = computeIndicators(input.bars, input.spot);
  return {
    symbol: input.symbol,
    now,
    spot: input.spot,
    riskFreeRate: 0.045,
    dividendYield: 0,
    technicals: {
      price: input.spot,
      ema20: indicators.ema20,
      ema50: indicators.ema50,
      ema200: indicators.ema200,
      rsi14: indicators.rsi14,
      atrPercent14: indicators.atrPercent14,
      hv20: indicators.hv20,
      support: indicators.levels.nearestSupport?.price ?? null,
      resistance: indicators.levels.nearestResistance?.price ?? null,
      week52High: indicators.range52w?.high ?? null,
      week52Low: indicators.range52w?.low ?? null,
      trendScore: indicators.trend.score,
      trendComplete: indicators.trend.complete,
    },
    // No accumulated IV history yet, so IV Rank is unavailable by design and
    // the IV/HV ratio stands in. This is the honest cold-start state.
    ivRank: ivRank(input.atmIv, []),
    ivHv: ivHvRatio(input.atmIv, indicators.hv20),
    earnings: null,
    regime,
  };
}

export async function runScan(strategy: StrategyTab): Promise<ScanResult> {
  const now = new Date();

  const regime = classifyMarketRegime({
    spy: { price: 604.12, ema20: 598.4, ema50: 588.1, ema200: 551.7 },
    qqq: { price: 523.8, ema20: 518.2, ema50: 508.9, ema200: 471.3 },
    vix: { level: 15.2, change5d: -0.9 },
    breadth: 0.62,
  });

  const expiry = new Date(now.getTime() + 21 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const inputs: SymbolInput[] = SAMPLE_UNIVERSE.map((underlying, i) => {
    const bars = sampleBars(underlying.spot, 300, 1000 + i);
    return {
      symbol: underlying.symbol,
      spot: underlying.spot,
      bars,
      contracts: sampleChain(underlying, expiry, now),
      atmIv: underlying.impliedVolatility,
    };
  });

  const rows: OpportunityRow[] = [];
  const rejections: Record<string, number> = {};
  let examined = 0;

  for (const input of inputs) {
    const context = buildContext(input, now, regime);
    const merge = (r: Readonly<Record<string, number>>) => {
      for (const [k, v] of Object.entries(r)) rejections[k] = (rejections[k] ?? 0) + v;
    };

    if (strategy === 'CSP') {
      // Pre-filter by right. Feeding calls to a put scanner would count each
      // one as a "missing-data" rejection, burying the rejections that
      // actually tell the user something about their filters.
      const puts = input.contracts.filter((c) => c.right === 'put');
      const summary = scanCsp(puts, context, DEFAULT_CSP_CONFIG);
      examined += summary.examined;
      merge(summary.rejections);
      for (const candidate of summary.candidates) {
        const m = candidate.metrics;
        rows.push({
          id: candidate.contract.occSymbol ?? `${input.symbol}-${m.strike}`,
          strategy: 'CSP',
          symbol: candidate.symbol,
          label: `$${m.strike} PUT`,
          expiration: candidate.contract.expiration.toISOString().slice(0, 10),
          dte: m.dte,
          score: candidate.score.score,
          delta: m.delta,
          premium: m.premium,
          distanceOtmPct: m.distanceOtmPct,
          annualizedYield: m.annualizedYieldSimple,
          probability: m.probabilityOtm,
          openInterest: candidate.contract.openInterest,
          spreadPct: m.spreadPct,
          collateral: m.collateral,
          breakdown: candidate.score,
          ladder: ladderFor(input.spot, m.strike, m.breakeven, m.expectedMove, 'Short put strike'),
          notes: [volatilityRichnessLabel(context.ivRank, context.ivHv)],
        });
      }
    } else if (strategy === 'CC') {
      const calls = input.contracts.filter((c) => c.right === 'call');
      const summary = scanCoveredCalls(calls, context, null, DEFAULT_CC_CONFIG);
      examined += summary.examined;
      merge(summary.rejections);
      for (const candidate of summary.candidates) {
        const m = candidate.metrics;
        rows.push({
          id: candidate.contract.occSymbol ?? `${input.symbol}-cc-${m.strike}`,
          strategy: 'CC',
          symbol: candidate.symbol,
          label: `$${m.strike} CALL`,
          expiration: candidate.contract.expiration.toISOString().slice(0, 10),
          dte: m.dte,
          score: candidate.score.score,
          delta: m.delta,
          premium: m.premium,
          distanceOtmPct: m.distanceOtmPct,
          annualizedYield: m.annualizedYieldSimple,
          probability: m.probabilityOfAssignment,
          openInterest: candidate.contract.openInterest,
          spreadPct: m.spreadPct,
          collateral: m.capitalBase * 100,
          breakdown: candidate.score,
          ladder: ladderFor(input.spot, m.strike, m.breakeven, m.expectedMove, 'Short call strike'),
          notes: [
            `Total return if assigned ${(m.totalReturnIfAssigned * 100).toFixed(1)}%`,
          ],
        });
      }
    } else {
      const kind = strategy === 'PCS' ? 'put-credit' : 'call-credit';
      const summary = scanCreditSpreads(kind, input.contracts, context, DEFAULT_SPREAD_CONFIG);
      examined += summary.examined;
      merge(summary.rejections);
      for (const candidate of summary.candidates) {
        const m = candidate.metrics;
        rows.push({
          id: `${input.symbol}-${strategy}-${m.shortStrike}-${m.longStrike}`,
          strategy,
          symbol: candidate.symbol,
          label: `${m.shortStrike}/${m.longStrike} ${strategy === 'PCS' ? 'PUT' : 'CALL'}`,
          expiration: candidate.shortContract.expiration.toISOString().slice(0, 10),
          dte: m.dte,
          score: candidate.score.score,
          delta: m.shortDelta,
          premium: m.credit,
          distanceOtmPct: m.distanceOtmPct,
          annualizedYield: null,
          probability: m.probabilityOfProfit,
          openInterest: m.minOpenInterest,
          spreadPct: m.worstSpreadPct,
          collateral: m.collateral,
          breakdown: candidate.score,
          ladder: ladderFor(
            input.spot,
            m.shortStrike,
            m.breakeven,
            m.expectedMove,
            'Short strike',
          ),
          notes: [
            `Max profit $${m.maxProfit.toFixed(2)} · max loss $${m.maxLoss.toFixed(2)} · ${(m.returnOnRisk * 100).toFixed(0)}% on risk`,
          ],
        });
      }
    }
  }

  rows.sort((a, b) => b.score - a.score);

  return {
    rows,
    regime,
    examined,
    rejections,
    generatedAt: now.toISOString(),
    mode: 'sample',
    error: null,
    marketTape: [
      { label: 'SPY', value: '604.12', tone: 'good' },
      { label: 'QQQ', value: '523.80', tone: 'good' },
      { label: 'VIX', value: '15.20', tone: 'good' },
      { label: 'Contracts', value: String(examined), tone: 'neutral' },
      { label: 'Candidates', value: String(rows.length), tone: 'neutral' },
    ],
  };
}
