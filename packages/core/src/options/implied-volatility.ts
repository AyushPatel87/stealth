/**
 * Implied volatility solver.
 *
 * Why this exists even though every provider we use reports an `iv` field:
 *
 *  1. Yahoo's implied volatility is documented as unreliable for deep OTM
 *     strikes - precisely the |delta| 0.05-0.15 band a CSP scanner lives in.
 *  2. Providers report `iv: 0` (or omit it) for untraded strikes.
 *  3. Cross-checking a vendor IV against one re-derived from the mid price is
 *     a cheap data-quality signal.
 *
 * Method: Newton-Raphson seeded with the Brenner-Subrahmanyam ATM
 * approximation, falling back to bisection when vega is too small for Newton to
 * be stable (which is exactly the deep-OTM case that motivates the solver).
 */

import {
  blackScholesPrice,
  type OptionRight,
  blackScholes,
} from './black-scholes.js';

export interface ImpliedVolInputs {
  /** Observed option price (typically the bid/ask mid). */
  readonly price: number;
  readonly spot: number;
  readonly strike: number;
  /** Time to expiry in YEARS. */
  readonly timeToExpiry: number;
  readonly riskFreeRate: number;
  readonly dividendYield?: number;
  readonly right: OptionRight;
}

export interface ImpliedVolResult {
  /** Annualised volatility as a decimal (0.30 = 30%). */
  readonly volatility: number;
  readonly iterations: number;
  readonly method: 'newton' | 'bisection';
}

/** Reason a price admits no implied volatility. */
export type ImpliedVolFailure =
  | 'expired'
  | 'below-intrinsic'
  | 'above-maximum'
  | 'non-positive-price'
  /**
   * The quote carries no recoverable volatility information. This happens for
   * deep in-the-money contracts, whose price is entirely intrinsic: measured
   * empirically, a 30-point-ITM 7-DTE call prices IDENTICALLY at the bit level
   * for volatilities of 8% and 20%, with vega around 1e-226. Any volatility
   * returned in that regime would be an artefact of where the solver happened
   * to start, so we refuse rather than invent one.
   */
  | 'not-identifiable'
  | 'no-convergence';

export type ImpliedVolOutcome =
  | { readonly ok: true; readonly result: ImpliedVolResult }
  | { readonly ok: false; readonly reason: ImpliedVolFailure };

const MIN_VOL = 1e-8;
const MAX_VOL = 10; // 1000% annualised - well beyond any real listed option.
const PRICE_TOLERANCE = 1e-10;
/**
 * Convergence is measured on VOLATILITY, not on price. Stopping when the price
 * residual is small is wrong for low-vega contracts: a residual under 1e-10 is
 * reachable while the volatility is still off by ~2e-3, because vega is the
 * conversion factor between the two and it can be arbitrarily small. Bisecting
 * to this width costs ~log2(10 / 1e-10) = 37 iterations, which is cheap.
 */
const VOL_TOLERANCE = 1e-10;
const MAX_NEWTON_ITERATIONS = 60;
const MAX_BISECTION_ITERATIONS = 200;
/** Below this, Newton's vega division is numerically untrustworthy. */
const MIN_USABLE_VEGA = 1e-10;

/**
 * No-arbitrage price bounds for a European option. A quoted price outside these
 * admits no implied volatility at all, which in practice means a stale or
 * crossed quote rather than a real arbitrage.
 */
export function priceBounds(
  inputs: Omit<ImpliedVolInputs, 'price'>,
): { readonly lower: number; readonly upper: number } {
  const { spot, strike, timeToExpiry, riskFreeRate, right } = inputs;
  const q = inputs.dividendYield ?? 0;
  const discountedSpot = spot * Math.exp(-q * timeToExpiry);
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeToExpiry);

  return right === 'call'
    ? {
        lower: Math.max(discountedSpot - discountedStrike, 0),
        upper: discountedSpot,
      }
    : {
        lower: Math.max(discountedStrike - discountedSpot, 0),
        upper: discountedStrike,
      };
}

/**
 * Solves for the volatility that reproduces `price` under Black-Scholes-Merton.
 *
 * Returns a discriminated outcome rather than throwing or returning NaN,
 * because unsolvable quotes are routine in a live options chain and the caller
 * needs to distinguish "stale quote" from "bad input".
 */
export function impliedVolatility(
  inputs: ImpliedVolInputs,
): ImpliedVolOutcome {
  const { price, spot, strike, timeToExpiry, riskFreeRate, right } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: 'non-positive-price' };
  }
  if (timeToExpiry <= 0) {
    return { ok: false, reason: 'expired' };
  }

  const { lower, upper } = priceBounds(inputs);
  if (price < lower - PRICE_TOLERANCE) {
    return { ok: false, reason: 'below-intrinsic' };
  }
  if (price > upper + PRICE_TOLERANCE) {
    return { ok: false, reason: 'above-maximum' };
  }

  // All of an option's volatility information lives in its EXTRINSIC value.
  // As extrinsic value shrinks relative to the quote, a widening band of
  // volatilities reproduces the same double-precision price and the inversion
  // becomes ill-posed. This threshold is measured, not guessed: over a 533-case
  // grid spanning moneyness 0.7-1.4, expiries 7d-2y and vols 8%-150%, the worst
  // relative recovery error behaves as
  //
  //   extrinsic/price > 1e-12 -> 2.4e-06     > 1e-8  -> 5.8e-10
  //   extrinsic/price > 1e-10 -> 1.0e-07     > 1e-6  -> 9.1e-11
  //
  // Cutting at 1e-8 keeps 518 of 533 cases with worst-case error 5.8e-10, and
  // rejects only contracts whose price genuinely cannot pin a volatility.
  const extrinsic = price - lower;
  const extrinsicFloor = Math.max(
    Math.abs(price) * 1e-8,
    Math.max(Math.abs(price), 1) * Number.EPSILON * 64,
  );
  if (extrinsic <= extrinsicFloor) {
    return { ok: false, reason: 'not-identifiable' };
  }

  const priceAt = (vol: number): number =>
    blackScholesPrice({
      spot,
      strike,
      timeToExpiry,
      volatility: vol,
      riskFreeRate,
      dividendYield: q,
      right,
    });

  // Brenner-Subrahmanyam: exact-ish at the money, a reasonable seed elsewhere.
  const seed = Math.min(
    Math.max(
      Math.sqrt((2 * Math.PI) / timeToExpiry) * (price / spot),
      0.05,
    ),
    3,
  );

  let vol = seed;
  for (let i = 1; i <= MAX_NEWTON_ITERATIONS; i += 1) {
    const evaluated = blackScholes({
      spot,
      strike,
      timeToExpiry,
      volatility: vol,
      riskFreeRate,
      dividendYield: q,
      right,
    });
    const diff = evaluated.price - price;

    // `vega` is per volatility POINT; convert back to per unit for Newton.
    const vegaPerUnit = evaluated.vega * 100;
    if (!Number.isFinite(vegaPerUnit) || vegaPerUnit < MIN_USABLE_VEGA) {
      break;
    }

    const next = vol - diff / vegaPerUnit;
    if (!Number.isFinite(next) || next <= MIN_VOL || next >= MAX_VOL) {
      break;
    }
    if (Math.abs(next - vol) < VOL_TOLERANCE) {
      return {
        ok: true,
        result: { volatility: next, iterations: i, method: 'newton' },
      };
    }
    vol = next;
  }

  // Bisection fallback. Price is monotonically increasing in volatility, so a
  // sign change is guaranteed whenever the price sits inside the bounds.
  let lo = MIN_VOL;
  let hi = MAX_VOL;
  if (priceAt(hi) < price - PRICE_TOLERANCE) {
    return { ok: false, reason: 'above-maximum' };
  }
  if (priceAt(lo) > price + PRICE_TOLERANCE) {
    return { ok: false, reason: 'below-intrinsic' };
  }

  for (let i = 1; i <= MAX_BISECTION_ITERATIONS; i += 1) {
    const mid = (lo + hi) / 2;

    if (hi - lo < VOL_TOLERANCE) {
      return {
        ok: true,
        result: { volatility: mid, iterations: i, method: 'bisection' },
      };
    }

    if (priceAt(mid) < price) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { ok: false, reason: 'no-convergence' };
}
