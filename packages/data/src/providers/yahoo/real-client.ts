/**
 * Adapter binding the real `yahoo-finance2` client to our `YahooClient` port.
 *
 * This is the ONLY file in the package that touches the library directly, and
 * deliberately the only untested one: it performs network I/O, which this
 * project's test suite never does. Everything of consequence - normalisation,
 * error classification, Greeks enrichment - sits behind the port and is fully
 * covered against fixtures.
 *
 * The casts at each boundary are intentional. Our wire types are a deliberate
 * restatement of the fields we actually consume, so a library type change shows
 * up here as one compile error rather than silently altering the normalisation
 * contract downstream.
 *
 * API NOTE: `yahoo-finance2` v4 exports a CLASS. Calling methods on the default
 * export directly is typed as `never` and does not work - the client must be
 * instantiated. This differs from v2/v3, where the default export was a ready
 * singleton, and is an easy upgrade trap.
 *
 * Schema validation is always enabled and deliberately not configurable:
 * validation failures are how Yahoo's schema drift becomes visible, and the
 * provider maps them to a non-retryable InvalidResponseError. An off switch
 * would only serve to convert a loud, diagnosable break into silently missing
 * fields.
 *
 * NOT VERIFIED AGAINST A LIVE ENDPOINT: this project's build environment blocks
 * outbound access to finance hosts, so this adapter has never been exercised
 * against Yahoo. Run the provider smoke check on a networked machine before
 * trusting it.
 */

import YahooFinance from 'yahoo-finance2';
import type {
  YahooChartResult,
  YahooClient,
  YahooOptionsResult,
  YahooQuoteLike,
  YahooQuoteSummaryResult,
} from './wire.js';

export interface RealYahooClientOptions {
  /**
   * Maximum in-flight requests inside the library's own queue. Defaults to 1.
   *
   * This is a second line of defence rather than the primary control: our
   * RateLimiter paces requests, but serialising here guarantees that no code
   * path bypassing it can burst against an endpoint that bans per IP.
   */
  readonly concurrency?: number;
}

export function createYahooClient(
  options: RealYahooClientOptions = {},
): YahooClient {
  const yahooFinance = new YahooFinance({
    queue: { concurrency: options.concurrency ?? 1 },
    // Surface validation failures as typed errors rather than console noise
    // during a 500-name scan.
    validation: { logErrors: false, logOptionsErrors: false },
    suppressNotices: ['yahooSurvey'],
    // Avoids an extra outbound request per process purely to check for updates.
    versionCheck: false,
  });

  return {
    async quote(symbol) {
      const result = await yahooFinance.quote(
        symbol,
        {},
        { validateResult: true },
      );
      return result as unknown as YahooQuoteLike;
    },

    async chart(symbol, chartOptions) {
      const result = await yahooFinance.chart(
        symbol,
        {
          period1: chartOptions.period1,
          ...(chartOptions.period2 === undefined
            ? {}
            : { period2: chartOptions.period2 }),
          interval: chartOptions.interval,
          // The array form yields the flat `quotes` list our normaliser expects.
          return: 'array',
        },
        { validateResult: true },
      );
      return result as unknown as YahooChartResult;
    },

    async options(symbol, optionsOptions) {
      const result = await yahooFinance.options(
        symbol,
        optionsOptions?.date === undefined ? {} : { date: optionsOptions.date },
        { validateResult: true },
      );
      return result as unknown as YahooOptionsResult;
    },

    async quoteSummary(symbol, summaryOptions) {
      const result = await yahooFinance.quoteSummary(
        symbol,
        { modules: [...summaryOptions.modules] },
        { validateResult: true },
      );
      return result as unknown as YahooQuoteSummaryResult;
    },
  };
}
