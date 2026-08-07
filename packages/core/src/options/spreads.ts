/**
 * Vertical credit spread mathematics (put credit spreads and call credit
 * spreads).
 *
 * Spread candidates are generated combinatorially - every short strike against
 * every lower long strike, across every expiration - so this module sees a very
 * large number of leg pairings, most of which are nonsense. It therefore
 * validates rather than assumes, and returns a discriminated result so that a
 * bad pairing is rejected with a reason instead of silently producing an
 * attractive-looking metric.
 *
 * The most important guard is `credit-exceeds-width`: a spread whose credit
 * exceeds its width would be risk-free money. In practice it never means that -
 * it means a stale or crossed quote on one leg. Left unchecked it produces a
 * negative max loss, an infinite return on risk, and a permanent fixture at the
 * top of the rankings.
 */

import { blackScholes } from './black-scholes.js';

export type SpreadKind = 'put-credit' | 'call-credit';

export interface VerticalSpreadInput {
  readonly kind: SpreadKind;
  /** Strike of the leg being sold. */
  readonly shortStrike: number;
  /** Strike of the protective leg being bought. */
  readonly longStrike: number;
  /** Premium received for the short leg (per share). */
  readonly shortCredit: number;
  /** Premium paid for the long leg (per share). */
  readonly longDebit: number;
  /** Shares per contract. Standard US equity options are 100. */
  readonly contractMultiplier?: number;
}

export interface VerticalSpreadMetrics {
  readonly kind: SpreadKind;
  /** Distance between the strikes, in dollars. */
  readonly width: number;
  /** Net premium received per share. */
  readonly netCredit: number;
  /** Maximum profit per share (equals the net credit). */
  readonly maxProfit: number;
  /** Maximum loss per share (width minus net credit). */
  readonly maxLoss: number;
  /** Underlying price at which the spread breaks even. */
  readonly breakeven: number;
  /** maxLoss / maxProfit - dollars risked per dollar of reward. */
  readonly riskRewardRatio: number;
  /** maxProfit / maxLoss - the return earned on capital at risk. */
  readonly returnOnRisk: number;
  readonly maxProfitPerContract: number;
  readonly maxLossPerContract: number;
  /** Capital a broker will hold against the position, per contract. */
  readonly collateralPerContract: number;
}

export type SpreadRejection =
  | 'strikes-not-ordered'
  | 'zero-width'
  | 'not-a-credit'
  | 'credit-exceeds-width'
  | 'invalid-input';

export type SpreadOutcome =
  | { readonly ok: true; readonly metrics: VerticalSpreadMetrics }
  | { readonly ok: false; readonly reason: SpreadRejection };

const DEFAULT_MULTIPLIER = 100;

/**
 * Evaluates a vertical credit spread.
 *
 * Strike ordering is enforced per kind, since it is what makes the position a
 * credit spread at all:
 *   put-credit  short strike ABOVE long strike (bullish)
 *   call-credit short strike BELOW long strike (bearish)
 */
export function verticalCreditSpread(
  input: VerticalSpreadInput,
): SpreadOutcome {
  const { kind, shortStrike, longStrike, shortCredit, longDebit } = input;
  const multiplier = input.contractMultiplier ?? DEFAULT_MULTIPLIER;

  const finite = [shortStrike, longStrike, shortCredit, longDebit, multiplier];
  if (finite.some((v) => !Number.isFinite(v))) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (shortStrike <= 0 || longStrike <= 0 || multiplier <= 0) {
    return { ok: false, reason: 'invalid-input' };
  }
  if (shortCredit < 0 || longDebit < 0) {
    return { ok: false, reason: 'invalid-input' };
  }

  const correctlyOrdered =
    kind === 'put-credit'
      ? shortStrike > longStrike
      : shortStrike < longStrike;

  if (shortStrike === longStrike) {
    return { ok: false, reason: 'zero-width' };
  }
  if (!correctlyOrdered) {
    return { ok: false, reason: 'strikes-not-ordered' };
  }

  const width = Math.abs(shortStrike - longStrike);
  const netCredit = shortCredit - longDebit;

  if (netCredit <= 0) {
    return { ok: false, reason: 'not-a-credit' };
  }
  if (netCredit >= width) {
    // Would imply risk-free profit; in reality a stale or crossed quote.
    return { ok: false, reason: 'credit-exceeds-width' };
  }

  const maxProfit = netCredit;
  const maxLoss = width - netCredit;
  const breakeven =
    kind === 'put-credit'
      ? shortStrike - netCredit
      : shortStrike + netCredit;

  return {
    ok: true,
    metrics: {
      kind,
      width,
      netCredit,
      maxProfit,
      maxLoss,
      breakeven,
      riskRewardRatio: maxLoss / maxProfit,
      returnOnRisk: maxProfit / maxLoss,
      maxProfitPerContract: maxProfit * multiplier,
      maxLossPerContract: maxLoss * multiplier,
      // Brokers hold the full width against a defined-risk vertical; the credit
      // received offsets it, so net cash required equals the max loss.
      collateralPerContract: maxLoss * multiplier,
    },
  };
}

export interface ProbabilityOfProfitInputs {
  readonly spot: number;
  /** Implied volatility of the SHORT leg - the leg that defines the risk. */
  readonly volatility: number;
  readonly yearsToExpiry: number;
  readonly riskFreeRate: number;
  readonly dividendYield?: number;
}

/**
 * Risk-neutral probability that a credit spread expires profitable.
 *
 * Computed against the BREAK-EVEN price rather than the short strike. Using the
 * short strike instead - a common shortcut - understates the true probability,
 * because the credit received provides a cushion beyond the strike. For a
 * typical 0.12-delta put credit spread the difference is several percentage
 * points, which is enough to reorder rankings.
 *
 * Caveats worth surfacing in the UI:
 *  - Risk-neutral, not a real-world forecast.
 *  - Uses a single volatility, so it ignores skew between the two legs.
 *  - European exercise; American early assignment is not modelled.
 */
export function probabilityOfProfit(
  metrics: VerticalSpreadMetrics,
  inputs: ProbabilityOfProfitInputs,
): number {
  const { spot, volatility, yearsToExpiry, riskFreeRate } = inputs;
  const dividendYield = inputs.dividendYield ?? 0;

  // A put credit spread profits when the underlying finishes ABOVE breakeven,
  // which is exactly the event "a call struck at breakeven finishes ITM".
  const right = metrics.kind === 'put-credit' ? 'call' : 'put';

  const evaluated = blackScholes({
    spot,
    strike: metrics.breakeven,
    timeToExpiry: yearsToExpiry,
    volatility,
    riskFreeRate,
    dividendYield,
    right,
  });

  return evaluated.probabilityItm;
}

/**
 * Expected value per contract under the risk-neutral measure, using a
 * two-outcome approximation (full profit or full loss).
 *
 * This deliberately ignores partial outcomes between the strikes, so it is a
 * ranking aid rather than a valuation. Reported separately from probability of
 * profit because a high-probability trade with poor risk/reward can carry a
 * worse expectancy than a lower-probability one - the single most common
 * mistake in premium selling.
 */
export function approximateExpectedValue(
  metrics: VerticalSpreadMetrics,
  probabilityOfProfitValue: number,
): number {
  const p = Math.min(Math.max(probabilityOfProfitValue, 0), 1);
  return (
    p * metrics.maxProfitPerContract - (1 - p) * metrics.maxLossPerContract
  );
}
