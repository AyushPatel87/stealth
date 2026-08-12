/**
 * Yahoo wire format -> normalised domain models.
 *
 * Kept separate from the provider so it can be tested exhaustively against
 * recorded payloads without any client, real or faked.
 */

import type {
  EarningsEvent,
  EarningsTiming,
  HistoricalBar,
  MarketState,
  OptionContract,
  Provenance,
  Quote,
} from '../../models';
import type {
  YahooCallOrPut,
  YahooChartResult,
  YahooQuoteLike,
  YahooQuoteSummaryResult,
} from './wire';

export const YAHOO_PROVIDER_ID = 'yahoo';

/**
 * Converts an optional numeric wire field to `number | null`.
 *
 * Absent, null, NaN and Infinity all collapse to null. Notably a legitimate 0
 * is PRESERVED: a zero bid on a far-OTM contract is real information (the
 * market is one-sided), quite different from an absent bid.
 */
export function optionalNumber(value: number | undefined | null): number | null {
  if (value === undefined || value === null) return null;
  return Number.isFinite(value) ? value : null;
}

function marketStateOf(raw: string | undefined): MarketState {
  switch (raw) {
    case 'REGULAR':
      return 'regular';
    case 'PRE':
    case 'PREPRE':
      return 'pre';
    case 'POST':
    case 'POSTPOST':
      return 'post';
    case 'CLOSED':
      return 'closed';
    default:
      return 'unknown';
  }
}

export function buildProvenance(
  fetchedAt: Date,
  delayedByMinutes: number | null,
): Provenance {
  return { source: YAHOO_PROVIDER_ID, fetchedAt, delayedByMinutes };
}

export function normalizeQuote(
  symbol: string,
  raw: YahooQuoteLike,
  fetchedAt: Date,
): Quote | null {
  const price = optionalNumber(raw.regularMarketPrice);
  // Without a price there is no usable quote; the caller raises MissingData.
  if (price === null) return null;

  return {
    symbol: raw.symbol ?? symbol,
    price,
    previousClose: optionalNumber(raw.regularMarketPreviousClose),
    open: optionalNumber(raw.regularMarketOpen),
    dayHigh: optionalNumber(raw.regularMarketDayHigh),
    dayLow: optionalNumber(raw.regularMarketDayLow),
    volume: optionalNumber(raw.regularMarketVolume),
    currency: raw.currency ?? null,
    marketState: marketStateOf(raw.marketState),
    provenance: buildProvenance(
      fetchedAt,
      optionalNumber(raw.exchangeDataDelayedBy),
    ),
  };
}

/**
 * Normalises daily bars, discarding any row with an incomplete OHLC.
 *
 * Yahoo emits null-filled rows for halted sessions and for the current
 * in-progress day before the open. Passing those into an EMA would corrupt
 * every subsequent value in the series, so they are dropped rather than
 * forward-filled - a gap is recoverable, a silently wrong moving average is not.
 */
export function normalizeBars(raw: YahooChartResult): HistoricalBar[] {
  const bars: HistoricalBar[] = [];

  for (const quote of raw.quotes) {
    const { open, high, low, close } = quote;
    if (
      open === null ||
      open === undefined ||
      high === null ||
      high === undefined ||
      low === null ||
      low === undefined ||
      close === null ||
      close === undefined
    ) {
      continue;
    }
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }

    bars.push({
      date: quote.date.toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: optionalNumber(quote.volume) ?? 0,
      adjClose: optionalNumber(quote.adjclose),
    });
  }

  return bars;
}

/**
 * Normalises a single option contract.
 *
 * `greeksSource` is always 'unavailable' here, because Yahoo supplies none.
 * The Greeks enricher fills them in and restamps the field.
 */
export function normalizeContract(
  raw: YahooCallOrPut,
  underlyingSymbol: string,
  right: 'call' | 'put',
): OptionContract {
  const iv = optionalNumber(raw.impliedVolatility);

  return {
    occSymbol: raw.contractSymbol,
    underlyingSymbol,
    expiration: raw.expiration,
    strike: raw.strike,
    right,
    bid: optionalNumber(raw.bid),
    ask: optionalNumber(raw.ask),
    last: optionalNumber(raw.lastPrice),
    volume: optionalNumber(raw.volume),
    openInterest: optionalNumber(raw.openInterest),
    // Yahoo reports 0 for untraded strikes; treat that as "no information"
    // rather than "zero volatility", which would price the contract at
    // intrinsic and give it a degenerate delta of exactly 0 or 1.
    impliedVolatility: iv !== null && iv > 0 ? iv : null,
    greeks: null,
    greeksSource: 'unavailable',
    inTheMoney: raw.inTheMoney ?? null,
    lastTradeDate: raw.lastTradeDate ?? null,
  };
}

/**
 * Infers report timing from the earnings timestamp's New York wall-clock hour.
 *
 * This is an INFERENCE, not a field Yahoo provides. Companies report before
 * the open or after the close, so a timestamp in the middle of the session
 * carries no information and yields 'unknown' rather than a guess. Timing only
 * changes the outcome for a report landing exactly on expiration day.
 */
export function inferEarningsTiming(date: Date): EarningsTiming {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }).format(date),
  );

  if (!Number.isFinite(hour)) return 'unknown';
  if (hour < 9) return 'before-open';
  if (hour >= 16) return 'after-close';
  return 'unknown';
}

/**
 * Extracts the next earnings event.
 *
 * Yahoo signals an unconfirmed date two ways: the explicit
 * `isEarningsDateEstimate` flag, and by returning `earningsDate` as a two-element
 * RANGE rather than a single timestamp. Both are treated as estimated, because
 * acting on a guessed date is materially different from acting on a confirmed
 * one and the UI must be able to say which it is.
 */
export function normalizeEarnings(
  symbol: string,
  raw: YahooQuoteSummaryResult,
  fetchedAt: Date,
  now: Date,
): EarningsEvent | null {
  const earnings = raw.calendarEvents?.earnings;
  const dates = earnings?.earningsDate;
  if (!dates || dates.length === 0) return null;

  const upcoming = dates
    .filter((d) => d instanceof Date && Number.isFinite(d.getTime()))
    .filter((d) => d.getTime() >= now.getTime())
    .sort((a, b) => a.getTime() - b.getTime());

  const next = upcoming[0] ?? null;
  if (next === null) return null;

  const isRange = dates.length > 1;
  const isEstimate = earnings?.isEarningsDateEstimate === true || isRange;

  return {
    symbol,
    date: next,
    isEstimate,
    timing: inferEarningsTiming(next),
    provenance: buildProvenance(fetchedAt, null),
  };
}
