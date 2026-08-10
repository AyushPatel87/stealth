/**
 * Yahoo Finance provider.
 *
 * Capability summary, verified against the shipped `yahoo-finance2` schema
 * rather than assumed:
 *   quotes            yes
 *   historical OHLCV  yes, with adjusted close
 *   options chain     yes, ONE REQUEST PER EXPIRATION
 *   implied vol       yes
 *   Greeks            NO - computed locally by the Greeks enricher
 *   earnings          yes, and uniquely it flags estimated vs confirmed dates
 *
 * The per-expiration granularity is the dominant cost: a 500-name universe at
 * five expirations each is 2,500 requests against an endpoint that publishes no
 * rate limits and bans per IP. Hence conservative pacing and long cache TTLs.
 */

import {
  InvalidResponseError,
  MissingDataError,
  ProviderUnavailableError,
  RateLimitedError,
} from '../../errors.js';
import type {
  EarningsEvent,
  ExpirationList,
  HistoricalSeries,
  OptionChain,
  Quote,
} from '../../models.js';
import type {
  HistoricalRequest,
  MarketDataProvider,
  ProviderCapabilities,
} from '../../provider.js';
import {
  YAHOO_PROVIDER_ID,
  buildProvenance,
  normalizeBars,
  normalizeContract,
  normalizeEarnings,
  normalizeQuote,
  optionalNumber,
} from './normalize.js';
import type { YahooClient } from './wire.js';

export const YAHOO_CAPABILITIES: ProviderCapabilities = {
  quotes: true,
  historicalPrices: true,
  optionsChain: true,
  earnings: true,
  impliedVolatility: true,
  // Verified: Yahoo's options response contains no delta/gamma/theta/vega/rho.
  greeks: false,
  openInterest: true,
  chainGranularity: 'per-expiration',
  typicalDelayMinutes: 15,
};

export interface YahooProviderOptions {
  readonly client: YahooClient;
  /** Injected for deterministic provenance timestamps in tests. */
  readonly now?: () => Date;
}

/**
 * Classifies a thrown value into the provider error taxonomy.
 *
 * The rate-limit check inspects the MESSAGE as well as any status code,
 * because Yahoo sometimes returns HTTP 200 with "Too Many Requests" in the
 * body. Keying only on status would let throttling masquerade as a parse
 * failure and burn the retry budget on the wrong strategy.
 */
function classifyError(
  error: unknown,
  operation: string,
  symbol: string,
): never {
  const context = { provider: YAHOO_PROVIDER_ID, operation, symbol, cause: error };
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  const status =
    typeof (error as { response?: { status?: number } })?.response?.status ===
    'number'
      ? (error as { response: { status: number } }).response.status
      : undefined;

  if (status === 429 || lower.includes('too many requests') || lower.includes('rate limit')) {
    throw new RateLimitedError('Yahoo throttled the request', context);
  }

  if (status === 404 || lower.includes('not found') || lower.includes('no data found')) {
    throw new MissingDataError(`Yahoo has no ${operation} data for ${symbol}`, context);
  }

  // yahoo-finance2 raises validation errors whenever Yahoo drifts a field.
  // Several such drifts occurred during 2026; they are not retryable.
  if (
    lower.includes('validation') ||
    lower.includes('schema') ||
    error?.constructor?.name === 'FailedYahooValidationError'
  ) {
    throw new InvalidResponseError(
      `Yahoo response failed validation for ${operation}`,
      { ...context, detail: message },
    );
  }

  throw new ProviderUnavailableError(
    `Yahoo request failed: ${message}`,
    status === undefined ? context : { ...context, statusCode: status },
  );
}

export class YahooProvider implements MarketDataProvider {
  readonly id = YAHOO_PROVIDER_ID;
  readonly capabilities = YAHOO_CAPABILITIES;

  readonly #client: YahooClient;
  readonly #now: () => Date;

  constructor(options: YahooProviderOptions) {
    this.#client = options.client;
    this.#now = options.now ?? (() => new Date());
  }

  async getQuote(symbol: string): Promise<Quote> {
    const fetchedAt = this.#now();
    let raw;
    try {
      raw = await this.#client.quote(symbol);
    } catch (error) {
      classifyError(error, 'getQuote', symbol);
    }

    const quote = normalizeQuote(symbol, raw, fetchedAt);
    if (quote === null) {
      throw new MissingDataError(`Yahoo returned no price for ${symbol}`, {
        provider: this.id,
        operation: 'getQuote',
        symbol,
      });
    }
    return quote;
  }

  async getHistoricalPrices(
    symbol: string,
    request: HistoricalRequest,
  ): Promise<HistoricalSeries> {
    const fetchedAt = this.#now();
    let raw;
    try {
      raw = await this.#client.chart(symbol, {
        period1: request.from,
        ...(request.to === undefined ? {} : { period2: request.to }),
        interval: '1d',
      });
    } catch (error) {
      classifyError(error, 'getHistoricalPrices', symbol);
    }

    const bars = normalizeBars(raw);
    if (bars.length === 0) {
      throw new MissingDataError(
        `Yahoo returned no usable bars for ${symbol}`,
        { provider: this.id, operation: 'getHistoricalPrices', symbol },
      );
    }

    return { symbol, bars, provenance: buildProvenance(fetchedAt, null) };
  }

  async getExpirations(symbol: string): Promise<ExpirationList> {
    const fetchedAt = this.#now();
    let raw;
    try {
      raw = await this.#client.options(symbol);
    } catch (error) {
      classifyError(error, 'getExpirations', symbol);
    }

    const expirations = [...raw.expirationDates].sort(
      (a, b) => a.getTime() - b.getTime(),
    );
    if (expirations.length === 0) {
      // A listed equity with no options is a normal, permanent condition -
      // not a failure to retry.
      throw new MissingDataError(`${symbol} has no listed options`, {
        provider: this.id,
        operation: 'getExpirations',
        symbol,
      });
    }

    return {
      symbol,
      expirations,
      provenance: buildProvenance(
        fetchedAt,
        optionalNumber(raw.quote.exchangeDataDelayedBy),
      ),
    };
  }

  async getOptionsChain(symbol: string, expiration: Date): Promise<OptionChain> {
    const fetchedAt = this.#now();
    let raw;
    try {
      raw = await this.#client.options(symbol, { date: expiration });
    } catch (error) {
      classifyError(error, 'getOptionsChain', symbol);
    }

    const group = raw.options[0];
    if (!group) {
      throw new MissingDataError(
        `Yahoo returned no chain for ${symbol} at ${expiration.toISOString()}`,
        { provider: this.id, operation: 'getOptionsChain', symbol },
      );
    }

    return {
      underlyingSymbol: raw.underlyingSymbol ?? symbol,
      underlyingPrice: optionalNumber(raw.quote.regularMarketPrice),
      expiration: group.expirationDate,
      calls: group.calls.map((c) => normalizeContract(c, symbol, 'call')),
      puts: group.puts.map((p) => normalizeContract(p, symbol, 'put')),
      provenance: buildProvenance(
        fetchedAt,
        optionalNumber(raw.quote.exchangeDataDelayedBy),
      ),
    };
  }

  async getEarnings(symbol: string): Promise<EarningsEvent | null> {
    const fetchedAt = this.#now();
    let raw;
    try {
      raw = await this.#client.quoteSummary(symbol, {
        modules: ['calendarEvents'],
      });
    } catch (error) {
      classifyError(error, 'getEarnings', symbol);
    }

    return normalizeEarnings(symbol, raw, fetchedAt, this.#now());
  }
}
