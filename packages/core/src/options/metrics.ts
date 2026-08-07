/**
 * Derived options metrics.
 *
 * A deliberate bias runs through this file: this scanner SELLS premium, so
 * wherever a choice exists between an optimistic and a conservative number, the
 * conservative one is computed alongside and the ambiguity is made explicit
 * rather than hidden. Mid-price yields are what screeners advertise; bid-price
 * yields are closer to what actually fills.
 */

import type { OptionRight } from './black-scholes.js';
import { DAYS_PER_YEAR } from './expiry.js';

/**
 * A raw contract quote. `bid`, `ask` and `last` are all optional because
 * providers genuinely omit them on thin contracts - Yahoo's schema marks bid,
 * ask, volume and openInterest as optional fields, and they are absent (not
 * null) on untraded strikes.
 */
export interface ContractQuote {
  readonly bid?: number | undefined;
  readonly ask?: number | undefined;
  readonly last?: number | undefined;
}

export type PremiumSource = 'bid-ask' | 'last-only' | 'unavailable';

export interface PremiumEstimate {
  /** Midpoint of the bid/ask. The optimistic fill assumption. */
  readonly mid: number | null;
  /**
   * What a SELLER should expect to receive: the bid. Using mid to compute yield
   * systematically overstates returns, and the error grows with spread width -
   * exactly the illiquid contracts that most need to be ranked down.
   */
  readonly conservative: number | null;
  readonly source: PremiumSource;
  /** Absolute bid/ask spread in dollars. */
  readonly spreadAbs: number | null;
  /** Bid/ask spread as a fraction of the mid. 0.10 = 10% wide. */
  readonly spreadPct: number | null;
  /** True when bid > ask, which indicates a stale or corrupt quote. */
  readonly crossed: boolean;
}

function isUsable(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Normalises a raw quote into the price estimates the rest of the engine uses.
 *
 * Never throws: a scanner iterating hundreds of thousands of contracts must
 * degrade to "unavailable" rather than abort a scan on one malformed row.
 */
export function premiumEstimate(quote: ContractQuote): PremiumEstimate {
  const { bid, ask, last } = quote;
  const hasBid = isUsable(bid);
  const hasAsk = isUsable(ask);

  if (hasBid && hasAsk) {
    const crossed = bid > ask;
    const mid = (bid + ask) / 2;
    const spreadAbs = ask - bid;
    return {
      mid,
      conservative: bid,
      source: 'bid-ask',
      spreadAbs,
      spreadPct: mid > 0 ? spreadAbs / mid : null,
      crossed,
    };
  }

  // A one-sided market carries no reliable mid. Fall back to last trade, but
  // mark it so liquidity scoring can penalise it.
  if (isUsable(last) && last > 0) {
    return {
      mid: last,
      conservative: last,
      source: 'last-only',
      spreadAbs: null,
      spreadPct: null,
      crossed: false,
    };
  }

  return {
    mid: null,
    conservative: null,
    source: 'unavailable',
    spreadAbs: null,
    spreadPct: null,
    crossed: false,
  };
}

/**
 * Distance out of the money as a fraction of spot. Positive is OTM, negative is
 * ITM, for both rights.
 */
export function distanceOtm(
  spot: number,
  strike: number,
  right: OptionRight,
): number {
  if (!(spot > 0)) {
    throw new RangeError(`spot must be positive, got ${spot}`);
  }
  return right === 'put' ? (spot - strike) / spot : (strike - spot) / spot;
}

/** Strike divided by spot. 1.0 is at the money. */
export function moneyness(spot: number, strike: number): number {
  if (!(spot > 0)) {
    throw new RangeError(`spot must be positive, got ${spot}`);
  }
  return strike / spot;
}

/**
 * Premium as a fraction of the capital committed.
 *
 * The caller supplies the capital base, because it differs by strategy and
 * getting it wrong silently rescales every yield:
 *   - cash-secured put: the strike (cash collateral is strike * 100)
 *   - covered call:     the cost basis, or spot for a new position
 */
export function premiumYield(premium: number, capitalBase: number): number {
  if (!(capitalBase > 0)) {
    throw new RangeError(`capitalBase must be positive, got ${capitalBase}`);
  }
  return premium / capitalBase;
}

/**
 * Annualises a period yield.
 *
 * `simple` scales linearly and is what options screeners conventionally
 * display. `compounded` assumes the same trade is rolled continuously, which is
 * the more defensible figure but produces eye-watering numbers at short DTE -
 * a 1% yield over 7 days annualises to 52% simple but 68% compounded.
 *
 * Both are returned so the UI can show one and justify it with the other,
 * rather than an unlabelled "annualised yield" that could mean either.
 */
export function annualizedYield(
  periodYield: number,
  days: number,
): { readonly simple: number; readonly compounded: number } {
  if (!(days > 0)) {
    throw new RangeError(`days must be positive, got ${days}`);
  }
  const periods = DAYS_PER_YEAR / days;
  return {
    simple: periodYield * periods,
    // (1 + y)^periods - 1 is undefined for y <= -1 (a total loss).
    compounded:
      periodYield <= -1
        ? Number.NEGATIVE_INFINITY
        : Math.pow(1 + periodYield, periods) - 1,
  };
}

export interface ExpectedMove {
  /** One standard deviation of price movement, in dollars. */
  readonly move: number;
  readonly lower: number;
  readonly upper: number;
  /**
   * Approximate probability the underlying finishes inside the range. A
   * one-sigma lognormal band, quoted as the conventional 68%.
   */
  readonly confidence: 0.68;
}

/**
 * Expected move from implied volatility: S * sigma * sqrt(T).
 *
 * This is the standard one-sigma approximation. It treats the move as
 * symmetric in dollars, which is a simplification of the lognormal
 * distribution, but it is the convention traders read and matches what broker
 * platforms display.
 */
export function expectedMoveFromIv(
  spot: number,
  impliedVolatility: number,
  yearsToExpiry: number,
): ExpectedMove {
  if (!(spot > 0)) {
    throw new RangeError(`spot must be positive, got ${spot}`);
  }
  if (impliedVolatility < 0) {
    throw new RangeError(
      `impliedVolatility must be non-negative, got ${impliedVolatility}`,
    );
  }
  if (yearsToExpiry < 0) {
    throw new RangeError(
      `yearsToExpiry must be non-negative, got ${yearsToExpiry}`,
    );
  }

  const move = spot * impliedVolatility * Math.sqrt(yearsToExpiry);
  return {
    move,
    lower: spot - move,
    upper: spot + move,
    confidence: 0.68,
  };
}

/**
 * Expected move approximated from the at-the-money straddle price.
 *
 * The 0.85 factor is the widely-used market rule of thumb relating straddle
 * price to a one-sigma move. Useful as a cross-check on the IV-derived figure:
 * a large disagreement between the two usually means the IV feed is stale.
 */
export function expectedMoveFromStraddle(
  spot: number,
  straddlePrice: number,
): ExpectedMove {
  if (!(spot > 0)) {
    throw new RangeError(`spot must be positive, got ${spot}`);
  }
  if (straddlePrice < 0) {
    throw new RangeError(
      `straddlePrice must be non-negative, got ${straddlePrice}`,
    );
  }
  const move = 0.85 * straddlePrice;
  return { move, lower: spot - move, upper: spot + move, confidence: 0.68 };
}

/**
 * Break-even for a short option position.
 *
 * Short put:  assigned below the strike, cushioned by the credit received.
 * Short call: called away above the strike, cushioned by the credit received.
 */
export function shortOptionBreakeven(
  strike: number,
  credit: number,
  right: OptionRight,
): number {
  return right === 'put' ? strike - credit : strike + credit;
}

/**
 * Where a price sits relative to an expected-move band, expressed in standard
 * deviations. Drives the strike-positioning visualisation: -1.5 means the
 * strike sits 1.5 sigma below spot.
 */
export function sigmasFromSpot(
  spot: number,
  price: number,
  expectedMove: number,
): number | null {
  if (!(expectedMove > 0)) return null;
  return (price - spot) / expectedMove;
}
