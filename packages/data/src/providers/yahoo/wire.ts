/**
 * Yahoo wire types.
 *
 * These mirror the response shapes `yahoo-finance2` validates against, which
 * are themselves generated from observed Yahoo responses. They are reproduced
 * here rather than imported so that a library upgrade changing its internal
 * types cannot silently change our normalisation contract - a schema drift
 * should surface as a compile error or a validation failure we handle, not as
 * quietly different data.
 *
 * The optionality below is load-bearing and was verified against the shipped
 * schema: on `CallOrPut`, only `contractSymbol`, `strike`, `lastPrice`,
 * `change`, `contractSize`, `expiration`, `lastTradeDate`, `impliedVolatility`
 * and `inTheMoney` are required. `bid`, `ask`, `volume` and `openInterest` are
 * OPTIONAL and are absent - not null - on thin contracts.
 *
 * Note also what is NOT here: there is no delta, gamma, theta, vega or rho
 * anywhere in Yahoo's options response. Greeks must be computed locally.
 */

export interface YahooCallOrPut {
  readonly contractSymbol: string;
  readonly strike: number;
  readonly currency?: string | undefined;
  readonly lastPrice: number;
  readonly change: number;
  readonly percentChange?: number | undefined;
  readonly volume?: number | undefined;
  readonly openInterest?: number | undefined;
  readonly bid?: number | undefined;
  readonly ask?: number | undefined;
  readonly contractSize: string;
  readonly expiration: Date;
  readonly lastTradeDate: Date;
  readonly impliedVolatility: number;
  readonly inTheMoney: boolean;
}

export interface YahooOptionExpiryGroup {
  readonly expirationDate: Date;
  readonly hasMiniOptions: boolean;
  readonly calls: readonly YahooCallOrPut[];
  readonly puts: readonly YahooCallOrPut[];
}

export interface YahooQuoteLike {
  readonly symbol?: string | undefined;
  readonly regularMarketPrice?: number | undefined;
  readonly regularMarketPreviousClose?: number | undefined;
  readonly regularMarketOpen?: number | undefined;
  readonly regularMarketDayHigh?: number | undefined;
  readonly regularMarketDayLow?: number | undefined;
  readonly regularMarketVolume?: number | undefined;
  readonly currency?: string | undefined;
  readonly marketState?: string | undefined;
  /** Exchange delay in minutes, as Yahoo reports it. */
  readonly exchangeDataDelayedBy?: number | undefined;
  readonly earningsTimestamp?: Date | undefined;
}

export interface YahooOptionsResult {
  readonly underlyingSymbol: string;
  readonly expirationDates: readonly Date[];
  readonly strikes: readonly number[];
  readonly hasMiniOptions: boolean;
  readonly quote: YahooQuoteLike;
  readonly options: readonly YahooOptionExpiryGroup[];
}

export interface YahooChartQuote {
  readonly date: Date;
  readonly open: number | null;
  readonly high: number | null;
  readonly low: number | null;
  readonly close: number | null;
  readonly volume: number | null;
  readonly adjclose?: number | null | undefined;
}

export interface YahooChartResult {
  readonly meta: {
    readonly symbol?: string | undefined;
    readonly currency?: string | undefined;
    readonly regularMarketPrice?: number | undefined;
  };
  readonly quotes: readonly YahooChartQuote[];
}

export interface YahooCalendarEvents {
  readonly earnings?: {
    readonly earningsDate?: readonly Date[] | undefined;
    readonly isEarningsDateEstimate?: boolean | undefined;
    readonly earningsCallDate?: readonly Date[] | undefined;
  };
}

export interface YahooQuoteSummaryResult {
  readonly calendarEvents?: YahooCalendarEvents | undefined;
}

/**
 * The `quoteSummary` modules this provider requests.
 *
 * Declared as a literal union rather than `string[]` so it assigns directly to
 * the library's own module union without an unsafe cast. The library exports
 * that union only from an internal path its `exports` map does not expose, so
 * restating the members we use is the type-safe option.
 */
export type YahooQuoteSummaryModule =
  | 'calendarEvents'
  | 'defaultKeyStatistics'
  | 'earnings'
  | 'price'
  | 'summaryDetail';

/**
 * The subset of `yahoo-finance2` this provider depends on.
 *
 * Injected rather than imported directly so the provider can be exercised
 * end-to-end against recorded fixtures, with no network access.
 */
export interface YahooClient {
  quote(symbol: string): Promise<YahooQuoteLike>;
  chart(
    symbol: string,
    options: { period1: Date; period2?: Date; interval: '1d' },
  ): Promise<YahooChartResult>;
  options(
    symbol: string,
    options?: { date?: Date },
  ): Promise<YahooOptionsResult>;
  quoteSummary(
    symbol: string,
    options: { modules: readonly YahooQuoteSummaryModule[] },
  ): Promise<YahooQuoteSummaryResult>;
}
