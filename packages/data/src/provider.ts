/**
 * The provider abstraction.
 *
 * Nothing above this layer may import a provider implementation. The scanner,
 * strategy and scoring engines see only these methods and the normalised models.
 *
 * `capabilities` exists because the free-provider landscape is genuinely
 * heterogeneous, and pretending otherwise produces silent wrongness. Yahoo
 * supplies implied volatility but no Greeks; Alpaca supplies both; CBOE supplies
 * both plus a 30-day IV. Declaring this up front lets the pipeline decide
 * whether to run the Greeks enricher, rather than discovering the gap by
 * finding `null` deltas mid-scan.
 */

import type {
  EarningsEvent,
  ExpirationList,
  HistoricalSeries,
  OptionChain,
  Quote,
} from './models';

export interface ProviderCapabilities {
  readonly quotes: boolean;
  readonly historicalPrices: boolean;
  readonly optionsChain: boolean;
  readonly earnings: boolean;

  /** Provider reports implied volatility per contract. */
  readonly impliedVolatility: boolean;
  /** Provider reports delta/gamma/theta/vega directly. */
  readonly greeks: boolean;
  /** Provider reports open interest. */
  readonly openInterest: boolean;

  /**
   * Whether one request returns every expiration, or one request is needed per
   * expiration. This single fact dominates scan wall-clock: Yahoo needs one
   * call per expiration, so a 500-name universe at 5 expirations is 2,500
   * requests, while a whole-chain provider needs 500.
   */
  readonly chainGranularity: 'whole-chain' | 'per-expiration';

  /** Typical exchange delay in minutes, or 0 for real time. */
  readonly typicalDelayMinutes: number;
}

export interface HistoricalRequest {
  /** Inclusive start of the range. */
  readonly from: Date;
  /** Exclusive end of the range. Defaults to now. */
  readonly to?: Date | undefined;
}

/**
 * The contract every market-data source implements.
 *
 * Implementations throw `ProviderError` subclasses and nothing else, so callers
 * can branch on error kind without unwrapping vendor-specific exceptions.
 */
export interface MarketDataProvider {
  /** Stable identifier recorded in `Provenance.source`. */
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  getQuote(symbol: string): Promise<Quote>;

  getHistoricalPrices(
    symbol: string,
    request: HistoricalRequest,
  ): Promise<HistoricalSeries>;

  getExpirations(symbol: string): Promise<ExpirationList>;

  /**
   * Options chain for one expiration. Providers whose `chainGranularity` is
   * `whole-chain` may ignore nothing - the expiration is always required here,
   * and whole-chain providers simply filter, so callers need not branch.
   */
  getOptionsChain(symbol: string, expiration: Date): Promise<OptionChain>;

  /**
   * Next scheduled earnings event, or null when the provider has none on record.
   * Returning null rather than throwing, because "no upcoming earnings" is a
   * normal and actionable answer, not a failure.
   */
  getEarnings(symbol: string): Promise<EarningsEvent | null>;
}

/** Capability set with everything disabled, for implementations to spread over. */
export const NO_CAPABILITIES: ProviderCapabilities = {
  quotes: false,
  historicalPrices: false,
  optionsChain: false,
  earnings: false,
  impliedVolatility: false,
  greeks: false,
  openInterest: false,
  chainGranularity: 'per-expiration',
  typicalDelayMinutes: 15,
};
