/**
 * Normalised domain models.
 *
 * The strategy and scoring engines depend ONLY on these types, never on a
 * provider's wire format. That is what makes providers swappable, which matters
 * because every free options source is undocumented, unstable, or both.
 *
 * Two conventions run throughout:
 *
 *  1. Optional upstream fields become `T | null`, never `undefined` and never a
 *     substituted default. Yahoo omits `bid`, `ask`, `volume` and
 *     `openInterest` entirely on thin contracts; defaulting those to 0 would
 *     silently turn "we don't know the open interest" into "this contract has
 *     no open interest", which the liquidity filter would then act on.
 *
 *  2. Every payload carries `provenance`, so the UI can always answer "where did
 *     this come from and how old is it" without the caller threading it through.
 */

import type { Greeks, OptionRight } from '@stealth/core';

/** Where a piece of data came from and when. */
export interface Provenance {
  /** Stable provider identifier, e.g. 'yahoo', 'alpaca', 'fixture'. */
  readonly source: string;
  /** When this application retrieved it. */
  readonly fetchedAt: Date;
  /**
   * Exchange delay the provider itself reports, in minutes. Read from the
   * provider rather than assumed, because it differs between the underlying
   * quote and the options legs. `null` when the provider does not say.
   */
  readonly delayedByMinutes: number | null;
}

export type MarketState =
  | 'pre'
  | 'regular'
  | 'post'
  | 'closed'
  | 'unknown';

export interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly previousClose: number | null;
  readonly open: number | null;
  readonly dayHigh: number | null;
  readonly dayLow: number | null;
  readonly volume: number | null;
  readonly currency: string | null;
  readonly marketState: MarketState;
  readonly provenance: Provenance;
}

/** A daily OHLCV bar. Mirrors `@stealth/core`'s `Bar` plus provenance. */
export interface HistoricalBar {
  readonly date: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly adjClose: number | null;
}

export interface HistoricalSeries {
  readonly symbol: string;
  readonly bars: readonly HistoricalBar[];
  readonly provenance: Provenance;
}

/** How a contract's Greeks were obtained. */
export type GreeksSource = 'provider' | 'computed' | 'unavailable';

export interface OptionContract {
  /** OCC-style contract symbol, when the provider supplies one. */
  readonly occSymbol: string | null;
  readonly underlyingSymbol: string;
  readonly expiration: Date;
  readonly strike: number;
  readonly right: OptionRight;

  readonly bid: number | null;
  readonly ask: number | null;
  readonly last: number | null;
  readonly volume: number | null;
  readonly openInterest: number | null;

  /** Annualised implied volatility as a decimal. */
  readonly impliedVolatility: number | null;

  /**
   * Greeks in the conventions defined by `@stealth/core`. Null when neither
   * supplied nor computable.
   */
  readonly greeks: Greeks | null;
  /**
   * Never let vendor-supplied and locally-derived Greeks be compared as
   * equivalent - they are computed under different assumptions.
   */
  readonly greeksSource: GreeksSource;

  readonly inTheMoney: boolean | null;
  readonly lastTradeDate: Date | null;
}

export interface OptionChain {
  readonly underlyingSymbol: string;
  /** Underlying price as of the chain snapshot, when the provider reports it. */
  readonly underlyingPrice: number | null;
  readonly expiration: Date;
  readonly calls: readonly OptionContract[];
  readonly puts: readonly OptionContract[];
  readonly provenance: Provenance;
}

export interface ExpirationList {
  readonly symbol: string;
  readonly expirations: readonly Date[];
  readonly provenance: Provenance;
}

/** When a company reports, relative to the trading session. */
export type EarningsTiming = 'before-open' | 'after-close' | 'unknown';

export interface EarningsEvent {
  readonly symbol: string;
  readonly date: Date;
  /**
   * True when the provider is projecting the date rather than reporting a
   * company-confirmed one. Surfaced in the UI, because excluding a trade on a
   * guessed date is a materially different decision from excluding it on a
   * confirmed one.
   */
  readonly isEstimate: boolean;
  readonly timing: EarningsTiming;
  readonly provenance: Provenance;
}

/**
 * Whether an earnings event falls inside a contract's life.
 *
 * Boundary handling is deliberate: an after-close report ON expiration day
 * lands after the option has already settled, so it does not affect the
 * position. A before-open report on expiration day does. Getting this wrong
 * either admits a trade over an earnings gap or discards a safe one.
 */
export function earningsBeforeExpiration(
  event: EarningsEvent,
  expiration: Date,
): boolean {
  const eventDay = event.date.getTime();
  const expiryDay = expiration.getTime();

  if (eventDay > expiryDay) return false;
  if (eventDay < expiryDay) return true;

  // Same instant: only a before-open report precedes settlement.
  return event.timing === 'before-open';
}

/** Age of a payload in milliseconds, relative to `now`. */
export function ageMs(provenance: Provenance, now: Date): number {
  return now.getTime() - provenance.fetchedAt.getTime();
}

/**
 * Effective age including the provider's own exchange delay. This is the number
 * the UI should display: data fetched 2 minutes ago from a 15-minute-delayed
 * feed reflects the market as of 17 minutes ago, and showing "2 minutes ago"
 * would overstate freshness by an order of magnitude.
 */
export function effectiveAgeMs(provenance: Provenance, now: Date): number {
  const delayMs = (provenance.delayedByMinutes ?? 0) * 60_000;
  return ageMs(provenance, now) + delayMs;
}
