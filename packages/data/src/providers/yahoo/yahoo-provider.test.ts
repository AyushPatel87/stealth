import { describe, expect, it, vi } from 'vitest';
import { YahooProvider } from './yahoo-provider';
import {
  inferEarningsTiming,
  normalizeBars,
  normalizeContract,
  normalizeEarnings,
  normalizeQuote,
  optionalNumber,
} from './normalize';
import type {
  YahooCallOrPut,
  YahooChartResult,
  YahooClient,
  YahooOptionsResult,
  YahooQuoteLike,
} from './wire';
import {
  InvalidResponseError,
  MissingDataError,
  ProviderUnavailableError,
  RateLimitedError,
} from '../../errors';

const FETCHED_AT = new Date('2026-08-07T18:30:00.000Z');
const EXPIRATION = new Date('2026-08-21T20:00:00.000Z');

/**
 * A fixture contract shaped exactly like Yahoo's wire format, including the
 * optionality that matters: bid/ask/volume/openInterest may be absent.
 */
function wireContract(overrides: Partial<YahooCallOrPut> = {}): YahooCallOrPut {
  return {
    contractSymbol: 'AAPL260821P00200000',
    strike: 200,
    lastPrice: 2.15,
    change: -0.1,
    contractSize: 'REGULAR',
    expiration: EXPIRATION,
    lastTradeDate: new Date('2026-08-07T17:45:00.000Z'),
    impliedVolatility: 0.2814,
    inTheMoney: false,
    bid: 2.1,
    ask: 2.2,
    volume: 340,
    openInterest: 5120,
    ...overrides,
  };
}

const wireQuote: YahooQuoteLike = {
  symbol: 'AAPL',
  regularMarketPrice: 212.34,
  regularMarketPreviousClose: 210.11,
  regularMarketOpen: 210.9,
  regularMarketDayHigh: 213.4,
  regularMarketDayLow: 209.8,
  regularMarketVolume: 48_120_000,
  currency: 'USD',
  marketState: 'REGULAR',
  exchangeDataDelayedBy: 15,
};

function optionsResult(
  overrides: Partial<YahooOptionsResult> = {},
): YahooOptionsResult {
  return {
    underlyingSymbol: 'AAPL',
    expirationDates: [
      new Date('2026-08-14T20:00:00.000Z'),
      EXPIRATION,
      new Date('2026-09-18T20:00:00.000Z'),
    ],
    strikes: [195, 200, 205],
    hasMiniOptions: false,
    quote: wireQuote,
    options: [
      {
        expirationDate: EXPIRATION,
        hasMiniOptions: false,
        calls: [wireContract({ strike: 220, contractSymbol: 'AAPL260821C00220000' })],
        puts: [wireContract()],
      },
    ],
    ...overrides,
  };
}

function makeClient(overrides: Partial<YahooClient> = {}): YahooClient {
  return {
    quote: vi.fn().mockResolvedValue(wireQuote),
    chart: vi.fn().mockResolvedValue({
      meta: { symbol: 'AAPL' },
      quotes: [
        {
          date: new Date('2026-08-05T00:00:00.000Z'),
          open: 209,
          high: 211,
          low: 208,
          close: 210,
          volume: 40_000_000,
          adjclose: 209.8,
        },
      ],
    } satisfies YahooChartResult),
    options: vi.fn().mockResolvedValue(optionsResult()),
    quoteSummary: vi.fn().mockResolvedValue({
      calendarEvents: {
        earnings: {
          earningsDate: [new Date('2026-10-29T20:30:00.000Z')],
          isEarningsDateEstimate: false,
        },
      },
    }),
    ...overrides,
  };
}

function makeProvider(client: YahooClient = makeClient()) {
  return new YahooProvider({ client, now: () => FETCHED_AT });
}

describe('YahooProvider capabilities', () => {
  it('declares that it supplies IV but NOT Greeks', () => {
    // This is the fact the whole enrichment path exists for. If it ever flips
    // silently, the enricher would stop running and deltas would go null.
    const provider = makeProvider();
    expect(provider.capabilities.impliedVolatility).toBe(true);
    expect(provider.capabilities.greeks).toBe(false);
  });

  it('declares per-expiration chain granularity', () => {
    // Drives scan cost: 500 names x 5 expirations = 2,500 requests.
    expect(makeProvider().capabilities.chainGranularity).toBe('per-expiration');
  });
});

describe('YahooProvider.getQuote', () => {
  it('normalises a quote with provenance and the reported delay', async () => {
    const quote = await makeProvider().getQuote('AAPL');
    expect(quote.symbol).toBe('AAPL');
    expect(quote.price).toBe(212.34);
    expect(quote.previousClose).toBe(210.11);
    expect(quote.marketState).toBe('regular');
    expect(quote.provenance.source).toBe('yahoo');
    expect(quote.provenance.fetchedAt).toEqual(FETCHED_AT);
    // Read from the provider rather than assumed.
    expect(quote.provenance.delayedByMinutes).toBe(15);
  });

  it('raises MissingData when there is no price', async () => {
    const client = makeClient({ quote: vi.fn().mockResolvedValue({ symbol: 'ZZZZ' }) });
    await expect(makeProvider(client).getQuote('ZZZZ')).rejects.toBeInstanceOf(
      MissingDataError,
    );
  });
});

describe('YahooProvider.getOptionsChain', () => {
  it('normalises calls and puts with Greeks left for the enricher', async () => {
    const chain = await makeProvider().getOptionsChain('AAPL', EXPIRATION);

    expect(chain.underlyingSymbol).toBe('AAPL');
    expect(chain.underlyingPrice).toBe(212.34);
    expect(chain.calls).toHaveLength(1);
    expect(chain.puts).toHaveLength(1);

    const put = chain.puts[0]!;
    expect(put.right).toBe('put');
    expect(put.strike).toBe(200);
    expect(put.impliedVolatility).toBeCloseTo(0.2814, 6);
    expect(put.greeks).toBeNull();
    expect(put.greeksSource).toBe('unavailable');
  });

  it('requests the specific expiration', async () => {
    const client = makeClient();
    await makeProvider(client).getOptionsChain('AAPL', EXPIRATION);
    expect(client.options).toHaveBeenCalledWith('AAPL', { date: EXPIRATION });
  });

  it('raises MissingData when the expiry group is absent', async () => {
    const client = makeClient({
      options: vi.fn().mockResolvedValue(optionsResult({ options: [] })),
    });
    await expect(
      makeProvider(client).getOptionsChain('AAPL', EXPIRATION),
    ).rejects.toBeInstanceOf(MissingDataError);
  });
});

describe('YahooProvider.getExpirations', () => {
  it('returns expirations in ascending order', async () => {
    const list = await makeProvider().getExpirations('AAPL');
    expect(list.expirations).toHaveLength(3);
    for (let i = 1; i < list.expirations.length; i += 1) {
      expect(list.expirations[i]!.getTime()).toBeGreaterThan(
        list.expirations[i - 1]!.getTime(),
      );
    }
  });

  it('treats an equity with no listed options as permanent missing data', async () => {
    // Non-retryable: retrying this across a 500-name universe wastes the
    // rate-limit budget on a condition that will never change.
    const client = makeClient({
      options: vi.fn().mockResolvedValue(optionsResult({ expirationDates: [] })),
    });
    const error = await makeProvider(client)
      .getExpirations('BRKB')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MissingDataError);
    expect((error as MissingDataError).retryable).toBe(false);
  });
});

describe('YahooProvider error classification', () => {
  it('detects throttling from the message even without a 429 status', async () => {
    // Yahoo sometimes returns HTTP 200 with "Too Many Requests" in the body.
    const client = makeClient({
      quote: vi.fn().mockRejectedValue(new Error('Too Many Requests')),
    });
    const error = await makeProvider(client).getQuote('AAPL').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryable).toBe(true);
  });

  it('detects throttling from a 429 status', async () => {
    const err = Object.assign(new Error('rejected'), { response: { status: 429 } });
    const client = makeClient({ quote: vi.fn().mockRejectedValue(err) });
    await expect(makeProvider(client).getQuote('AAPL')).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('maps a not-found response to non-retryable missing data', async () => {
    const client = makeClient({
      quote: vi.fn().mockRejectedValue(new Error('Not Found')),
    });
    await expect(makeProvider(client).getQuote('NOPE')).rejects.toBeInstanceOf(
      MissingDataError,
    );
  });

  it('maps schema drift to a non-retryable invalid response', async () => {
    const err = new Error('Validation failed for quote');
    const client = makeClient({ quote: vi.fn().mockRejectedValue(err) });
    const error = await makeProvider(client).getQuote('AAPL').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect((error as InvalidResponseError).retryable).toBe(false);
  });

  it('maps everything else to a retryable unavailability', async () => {
    const client = makeClient({
      quote: vi.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    const error = await makeProvider(client).getQuote('AAPL').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).retryable).toBe(true);
  });
});

describe('normalisation details', () => {
  it('preserves a legitimate zero but discards absent and non-finite values', () => {
    // A zero bid on a far-OTM contract is real information (one-sided market),
    // quite different from an absent bid.
    expect(optionalNumber(0)).toBe(0);
    expect(optionalNumber(undefined)).toBeNull();
    expect(optionalNumber(null)).toBeNull();
    expect(optionalNumber(Number.NaN)).toBeNull();
    expect(optionalNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('maps absent bid/ask/volume/openInterest to null, not zero', () => {
    // Verified against the shipped schema: these four are OPTIONAL and are
    // absent (not null) on thin contracts. Defaulting them to 0 would turn
    // "unknown open interest" into "no open interest".
    const thin = normalizeContract(
      {
        contractSymbol: 'X',
        strike: 100,
        lastPrice: 0.05,
        change: 0,
        contractSize: 'REGULAR',
        expiration: EXPIRATION,
        lastTradeDate: FETCHED_AT,
        impliedVolatility: 0.9,
        inTheMoney: false,
      },
      'X',
      'put',
    );

    expect(thin.bid).toBeNull();
    expect(thin.ask).toBeNull();
    expect(thin.volume).toBeNull();
    expect(thin.openInterest).toBeNull();
    expect(thin.impliedVolatility).toBeCloseTo(0.9, 9);
  });

  it('treats a reported zero implied volatility as no information', () => {
    const contract = normalizeContract(
      wireContract({ impliedVolatility: 0 }),
      'AAPL',
      'put',
    );
    expect(contract.impliedVolatility).toBeNull();
  });

  it('drops bars with incomplete OHLC rather than forward-filling them', () => {
    // Yahoo emits null-filled rows for halted sessions and the in-progress day.
    // Feeding those into an EMA would corrupt every subsequent value.
    const bars = normalizeBars({
      meta: {},
      quotes: [
        { date: new Date('2026-08-03T00:00:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { date: new Date('2026-08-04T00:00:00Z'), open: null, high: null, low: null, close: null, volume: null },
        { date: new Date('2026-08-05T00:00:00Z'), open: 2, high: 3, low: 1.5, close: 2.5, volume: 20 },
      ],
    });

    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.date)).toEqual(['2026-08-03', '2026-08-05']);
  });

  it('defaults missing volume to zero but keeps adjClose nullable', () => {
    const bars = normalizeBars({
      meta: {},
      quotes: [
        { date: new Date('2026-08-03T00:00:00Z'), open: 1, high: 2, low: 0.5, close: 1.5, volume: null },
      ],
    });
    expect(bars[0]!.volume).toBe(0);
    expect(bars[0]!.adjClose).toBeNull();
  });

  it('maps market states', () => {
    for (const [raw, expected] of [
      ['REGULAR', 'regular'],
      ['PRE', 'pre'],
      ['PREPRE', 'pre'],
      ['POST', 'post'],
      ['POSTPOST', 'post'],
      ['CLOSED', 'closed'],
      ['WEIRD', 'unknown'],
      [undefined, 'unknown'],
    ] as const) {
      const quote = normalizeQuote(
        'X',
        { regularMarketPrice: 1, marketState: raw },
        FETCHED_AT,
      );
      expect(quote?.marketState).toBe(expected);
    }
  });
});

describe('earnings normalisation', () => {
  const now = new Date('2026-08-07T18:30:00.000Z');

  it('returns the next confirmed earnings date', () => {
    const event = normalizeEarnings(
      'AAPL',
      {
        calendarEvents: {
          earnings: {
            earningsDate: [new Date('2026-10-29T20:30:00.000Z')],
            isEarningsDateEstimate: false,
          },
        },
      },
      FETCHED_AT,
      now,
    );

    expect(event?.date.toISOString()).toBe('2026-10-29T20:30:00.000Z');
    expect(event?.isEstimate).toBe(false);
  });

  it('treats an explicit estimate flag as estimated', () => {
    const event = normalizeEarnings(
      'AAPL',
      {
        calendarEvents: {
          earnings: {
            earningsDate: [new Date('2026-10-29T20:30:00.000Z')],
            isEarningsDateEstimate: true,
          },
        },
      },
      FETCHED_AT,
      now,
    );
    expect(event?.isEstimate).toBe(true);
  });

  it('treats a two-element date RANGE as estimated', () => {
    // Yahoo signals an unconfirmed date by returning a range rather than a
    // single timestamp, independently of the boolean flag.
    const event = normalizeEarnings(
      'AAPL',
      {
        calendarEvents: {
          earnings: {
            earningsDate: [
              new Date('2026-10-27T12:00:00.000Z'),
              new Date('2026-10-31T12:00:00.000Z'),
            ],
          },
        },
      },
      FETCHED_AT,
      now,
    );
    expect(event?.isEstimate).toBe(true);
    // The earliest date in the range is the conservative choice.
    expect(event?.date.toISOString()).toBe('2026-10-27T12:00:00.000Z');
  });

  it('ignores earnings dates already in the past', () => {
    const event = normalizeEarnings(
      'AAPL',
      {
        calendarEvents: {
          earnings: { earningsDate: [new Date('2026-05-01T20:30:00.000Z')] },
        },
      },
      FETCHED_AT,
      now,
    );
    expect(event).toBeNull();
  });

  it('returns null when the provider has no earnings on record', () => {
    expect(normalizeEarnings('AAPL', {}, FETCHED_AT, now)).toBeNull();
    expect(
      normalizeEarnings('AAPL', { calendarEvents: { earnings: {} } }, FETCHED_AT, now),
    ).toBeNull();
  });

  it('returns null rather than throwing when earnings are absent', async () => {
    const client = makeClient({ quoteSummary: vi.fn().mockResolvedValue({}) });
    await expect(makeProvider(client).getEarnings('AAPL')).resolves.toBeNull();
  });
});

describe('inferEarningsTiming', () => {
  it('infers before-open from an early New York hour', () => {
    // 12:00 UTC is 08:00 EDT.
    expect(inferEarningsTiming(new Date('2026-10-29T12:00:00.000Z'))).toBe(
      'before-open',
    );
  });

  it('infers after-close from a late New York hour', () => {
    // 20:30 UTC is 16:30 EDT.
    expect(inferEarningsTiming(new Date('2026-10-29T20:30:00.000Z'))).toBe(
      'after-close',
    );
  });

  it('returns unknown mid-session rather than guessing', () => {
    // 18:00 UTC is 14:00 EDT - companies do not report then, so the timestamp
    // carries no timing information.
    expect(inferEarningsTiming(new Date('2026-10-29T18:00:00.000Z'))).toBe(
      'unknown',
    );
  });

  it('accounts for the New York timezone, not UTC', () => {
    // 02:00 UTC is 22:00 the PREVIOUS day in New York - after the close.
    expect(inferEarningsTiming(new Date('2026-10-30T02:00:00.000Z'))).toBe(
      'after-close',
    );
  });
});
