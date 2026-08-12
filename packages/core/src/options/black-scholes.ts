/**
 * Black-Scholes-Merton pricing and Greeks, with a continuous dividend yield.
 *
 * IMPORTANT MODELLING CAVEAT
 * --------------------------
 * US single-name equity options are AMERICAN (exercisable early); BSM prices
 * EUROPEAN options. For the out-of-the-money short strikes this scanner targets
 * the difference is negligible, but it is real for in-the-money puts on
 * dividend-paying names, where early exercise carries value BSM cannot express.
 * Consumers should treat these values as a well-understood approximation and
 * consult `bsmLimitations()` before presenting them as exact. A
 * Bjerksund-Stensland American approximation is the intended upgrade path.
 *
 * UNIT CONVENTIONS
 * ----------------
 * Mixing Greek conventions is the single most common source of silent error in
 * options tooling, so every unit is stated explicitly and named unambiguously:
 *
 *   delta  per $1 move in the underlying          (dimensionless, -1..1)
 *   gamma  delta change per $1 move               (per $)
 *   theta  per CALENDAR DAY                       (annual value / 365)
 *   vega   per 1 VOLATILITY POINT (i.e. 1%)       (annual value / 100)
 *   rho    per 1 PERCENTAGE POINT of rates        (annual value / 100)
 *
 * These are the conventions retail brokers display. `rawGreeks()` exposes the
 * unscaled per-annum / per-unit values for anyone doing further calculus.
 */

import { normCdf, normPdf } from '../math/normal';

export type OptionRight = 'call' | 'put';

export interface BsmInputs {
  /** Underlying spot price. Must be > 0. */
  readonly spot: number;
  /** Strike price. Must be > 0. */
  readonly strike: number;
  /** Time to expiry in YEARS. Values <= 0 are treated as expired. */
  readonly timeToExpiry: number;
  /** Annualised implied volatility as a decimal (0.30 = 30%). */
  readonly volatility: number;
  /** Annualised continuously-compounded risk-free rate as a decimal. */
  readonly riskFreeRate: number;
  /** Annualised continuous dividend yield as a decimal. Defaults to 0. */
  readonly dividendYield?: number;
  readonly right: OptionRight;
}

export interface Greeks {
  /** Per $1 move in the underlying. */
  readonly delta: number;
  /** Change in delta per $1 move in the underlying. */
  readonly gamma: number;
  /** Per calendar day. Negative for long options. */
  readonly theta: number;
  /** Per 1 volatility point (1%). */
  readonly vega: number;
  /** Per 1 percentage point change in the risk-free rate. */
  readonly rho: number;
}

export interface BsmResult extends Greeks {
  readonly price: number;
  /** Risk-neutral probability the option expires in the money. */
  readonly probabilityItm: number;
  /** Risk-neutral probability the option expires out of the money. */
  readonly probabilityOtm: number;
  readonly d1: number;
  readonly d2: number;
}

const DAYS_PER_YEAR = 365;

function intrinsicValue(
  spot: number,
  strike: number,
  right: OptionRight,
): number {
  return right === 'call'
    ? Math.max(spot - strike, 0)
    : Math.max(strike - spot, 0);
}

/**
 * Computes d1 and d2. Callers must have already excluded the degenerate cases
 * (T <= 0, sigma <= 0), which would divide by zero here.
 */
function computeD(
  inputs: Required<Pick<BsmInputs, 'dividendYield'>> & BsmInputs,
): { d1: number; d2: number } {
  const { spot, strike, timeToExpiry, volatility, riskFreeRate } = inputs;
  const q = inputs.dividendYield;
  const sigmaSqrtT = volatility * Math.sqrt(timeToExpiry);
  const d1 =
    (Math.log(spot / strike) +
      (riskFreeRate - q + (volatility * volatility) / 2) * timeToExpiry) /
    sigmaSqrtT;
  return { d1, d2: d1 - sigmaSqrtT };
}

/**
 * Handles expiry (T <= 0) and zero-volatility, both of which are legitimate
 * inputs in a live scanner: contracts expiring today, and providers that report
 * `impliedVolatility: 0` for untraded strikes.
 */
function degenerateResult(inputs: BsmInputs): BsmResult {
  const { spot, strike, timeToExpiry, riskFreeRate, right } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (timeToExpiry <= 0) {
    const intrinsic = intrinsicValue(spot, strike, right);
    const itm = intrinsic > 0;
    return {
      price: intrinsic,
      delta: itm ? (right === 'call' ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
      probabilityItm: itm ? 1 : 0,
      probabilityOtm: itm ? 0 : 1,
      d1: itm ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
      d2: itm ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
    };
  }

  // sigma <= 0 with T > 0: the forward is deterministic.
  const discount = Math.exp(-riskFreeRate * timeToExpiry);
  const forward = spot * Math.exp((riskFreeRate - q) * timeToExpiry);
  const finishesItm =
    right === 'call' ? forward > strike : forward < strike;
  const price = discount * intrinsicValue(forward, strike, right);

  return {
    price,
    delta: finishesItm
      ? (right === 'call' ? 1 : -1) * Math.exp(-q * timeToExpiry)
      : 0,
    gamma: 0,
    theta: 0,
    vega: 0,
    rho: 0,
    probabilityItm: finishesItm ? 1 : 0,
    probabilityOtm: finishesItm ? 0 : 1,
    d1: finishesItm ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
    d2: finishesItm ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
  };
}

/**
 * Full BSM evaluation: price, Greeks (in trader conventions) and risk-neutral
 * exercise probabilities, from a single set of d1/d2 evaluations.
 *
 * @throws RangeError if spot or strike is non-positive, or any input is NaN.
 */
export function blackScholes(inputs: BsmInputs): BsmResult {
  const { spot, strike, timeToExpiry, volatility, riskFreeRate, right } =
    inputs;
  const q = inputs.dividendYield ?? 0;

  if (!Number.isFinite(spot) || spot <= 0) {
    throw new RangeError(`spot must be a positive finite number, got ${spot}`);
  }
  if (!Number.isFinite(strike) || strike <= 0) {
    throw new RangeError(
      `strike must be a positive finite number, got ${strike}`,
    );
  }
  if (!Number.isFinite(timeToExpiry)) {
    throw new RangeError(`timeToExpiry must be finite, got ${timeToExpiry}`);
  }
  if (!Number.isFinite(volatility)) {
    throw new RangeError(`volatility must be finite, got ${volatility}`);
  }
  if (!Number.isFinite(riskFreeRate) || !Number.isFinite(q)) {
    throw new RangeError('riskFreeRate and dividendYield must be finite');
  }

  if (timeToExpiry <= 0 || volatility <= 0) {
    return degenerateResult(inputs);
  }

  const { d1, d2 } = computeD({ ...inputs, dividendYield: q });

  const sqrtT = Math.sqrt(timeToExpiry);
  const discountR = Math.exp(-riskFreeRate * timeToExpiry);
  const discountQ = Math.exp(-q * timeToExpiry);
  const pdfD1 = normPdf(d1);

  const nD1 = normCdf(d1);
  const nD2 = normCdf(d2);
  const nMinusD1 = normCdf(-d1);
  const nMinusD2 = normCdf(-d2);

  const isCall = right === 'call';

  const price = isCall
    ? spot * discountQ * nD1 - strike * discountR * nD2
    : strike * discountR * nMinusD2 - spot * discountQ * nMinusD1;

  const delta = isCall ? discountQ * nD1 : -discountQ * nMinusD1;
  const gamma = (discountQ * pdfD1) / (spot * volatility * sqrtT);

  // Per-annum vega, then scaled to one volatility point.
  const vegaAnnual = spot * discountQ * pdfD1 * sqrtT;

  // Per-annum theta, then scaled to one calendar day.
  const decayTerm = -(spot * pdfD1 * volatility * discountQ) / (2 * sqrtT);
  const thetaAnnual = isCall
    ? decayTerm -
      riskFreeRate * strike * discountR * nD2 +
      q * spot * discountQ * nD1
    : decayTerm +
      riskFreeRate * strike * discountR * nMinusD2 -
      q * spot * discountQ * nMinusD1;

  const rhoAnnual = isCall
    ? strike * timeToExpiry * discountR * nD2
    : -strike * timeToExpiry * discountR * nMinusD2;

  // Risk-neutral probability of finishing in the money.
  // NOTE: this is N(d2) under the risk-neutral measure, NOT a real-world
  // forecast, and it is NOT the same as |delta| (which is discountQ * N(d1)).
  const probabilityItm = isCall ? nD2 : nMinusD2;

  return {
    price,
    delta,
    gamma,
    theta: thetaAnnual / DAYS_PER_YEAR,
    vega: vegaAnnual / 100,
    rho: rhoAnnual / 100,
    probabilityItm,
    probabilityOtm: 1 - probabilityItm,
    d1,
    d2,
  };
}

/** Convenience wrapper returning only the option's theoretical price. */
export function blackScholesPrice(inputs: BsmInputs): number {
  return blackScholes(inputs).price;
}

/**
 * Per-annum / per-unit Greeks, without the display scaling applied by
 * `blackScholes`. Useful for further calculus where the /365 and /100 factors
 * would need to be undone.
 */
export function rawGreeks(inputs: BsmInputs): Greeks {
  const g = blackScholes(inputs);
  return {
    delta: g.delta,
    gamma: g.gamma,
    theta: g.theta * DAYS_PER_YEAR,
    vega: g.vega * 100,
    rho: g.rho * 100,
  };
}

/**
 * Machine-readable statement of where this model is known to be wrong, so the
 * UI can surface caveats rather than implying false precision.
 */
export function bsmLimitations(): readonly string[] {
  return [
    'European exercise assumed; US equity options are American. Early-exercise value is not captured.',
    'Continuous dividend yield assumed; discrete ex-dividend dates are not modelled.',
    'Constant volatility assumed; the volatility smile/skew across strikes is not modelled.',
    'Probabilities are risk-neutral, not real-world forecasts.',
  ];
}
