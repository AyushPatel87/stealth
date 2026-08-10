/**
 * Database schema.
 *
 * Sizing drove several decisions here. A full S&P 500 + NASDAQ 100 scan touches
 * roughly 500 symbols x ~5 expirations in the DTE window x ~150 strikes, which
 * is about 375,000 contract rows PER CYCLE. Retaining every cycle would reach
 * hundreds of millions of rows within weeks for no MVP benefit, so
 * `option_quotes` holds only the current snapshot (upserted per contract) while
 * `iv_history` keeps the one daily datum that genuinely must accumulate.
 *
 * That accumulation is not incidental: IV Rank requires 52 weeks of historical
 * implied volatility, and no free provider offers it. Recording ATM IV daily
 * from first run is the only way to ever have a true IV Rank, and until enough
 * history exists the scanners fall back to the IV/HV ratio.
 */

import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const optionRightEnum = pgEnum('option_right', ['call', 'put']);
export const greeksSourceEnum = pgEnum('greeks_source', [
  'provider',
  'computed',
  'unavailable',
]);
export const strategyEnum = pgEnum('strategy', ['CSP', 'CC', 'PCS', 'CCS']);
export const trendEnum = pgEnum('trend_label', [
  'strong-uptrend',
  'uptrend',
  'neutral',
  'downtrend',
  'strong-downtrend',
]);
export const regimeEnum = pgEnum('market_regime', [
  'bullish',
  'neutral',
  'bearish',
  'high-volatility',
]);
export const earningsTimingEnum = pgEnum('earnings_timing', [
  'before-open',
  'after-close',
  'unknown',
]);
export const scanStatusEnum = pgEnum('scan_status', [
  'running',
  'succeeded',
  'failed',
  'partial',
]);
export const providerStatusEnum = pgEnum('provider_status', [
  'healthy',
  'degraded',
  'down',
]);

export const symbols = pgTable(
  'symbols',
  {
    id: serial('id').primaryKey(),
    ticker: text('ticker').notNull(),
    /**
     * Provider-specific spelling. Index sources use `BRK.B`; Yahoo wants
     * `BRK-B`. Storing both avoids silently dropping those names at ingest.
     */
    yahooTicker: text('yahoo_ticker').notNull(),
    name: text('name'),
    sector: text('sector'),
    exchange: text('exchange'),
    optionable: boolean('optionable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('symbols_ticker_key').on(t.ticker)],
);

export const universes = pgTable(
  'universes',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
  },
  (t) => [uniqueIndex('universes_code_key').on(t.code)],
);

export const universeMembers = pgTable(
  'universe_members',
  {
    universeId: integer('universe_id')
      .notNull()
      .references(() => universes.id, { onDelete: 'cascade' }),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.universeId, t.symbolId] })],
);

export const dailyBars = pgTable(
  'daily_bars',
  {
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    open: doublePrecision('open').notNull(),
    high: doublePrecision('high').notNull(),
    low: doublePrecision('low').notNull(),
    /** Split-adjusted. The basis for all indicators. */
    close: doublePrecision('close').notNull(),
    /** Split AND dividend adjusted; for total-return maths only. */
    adjClose: doublePrecision('adj_close'),
    volume: doublePrecision('volume').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.symbolId, t.date] })],
);

export const quotes = pgTable('quotes', {
  symbolId: integer('symbol_id')
    .primaryKey()
    .references(() => symbols.id, { onDelete: 'cascade' }),
  price: doublePrecision('price').notNull(),
  previousClose: doublePrecision('previous_close'),
  open: doublePrecision('open'),
  dayHigh: doublePrecision('day_high'),
  dayLow: doublePrecision('day_low'),
  volume: doublePrecision('volume'),
  marketState: text('market_state').notNull().default('unknown'),
  source: text('source').notNull(),
  /** Exchange delay the provider itself reported, not an assumption. */
  delayedByMinutes: integer('delayed_by_minutes'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
});

export const indicators = pgTable('indicators', {
  symbolId: integer('symbol_id')
    .primaryKey()
    .references(() => symbols.id, { onDelete: 'cascade' }),
  price: doublePrecision('price').notNull(),
  barCount: integer('bar_count').notNull(),

  /** Nullable throughout: a newly-listed name genuinely has no 200 EMA. */
  ema20: doublePrecision('ema20'),
  ema50: doublePrecision('ema50'),
  ema100: doublePrecision('ema100'),
  ema200: doublePrecision('ema200'),

  rsi14: doublePrecision('rsi14'),
  roc20: doublePrecision('roc20'),
  return1m: doublePrecision('return_1m'),
  return3m: doublePrecision('return_3m'),

  atr14: doublePrecision('atr14'),
  atrPercent14: doublePrecision('atr_percent_14'),
  hv20: doublePrecision('hv20'),
  hv60: doublePrecision('hv60'),

  trend: trendEnum('trend').notNull(),
  trendScore: doublePrecision('trend_score').notNull(),
  /** False when a long-period average was unavailable; callers down-weight. */
  trendComplete: boolean('trend_complete').notNull(),

  support: doublePrecision('support'),
  resistance: doublePrecision('resistance'),
  week52High: doublePrecision('week_52_high'),
  week52Low: doublePrecision('week_52_low'),
  vwap20: doublePrecision('vwap20'),

  computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
});

export const optionContracts = pgTable(
  'option_contracts',
  {
    id: serial('id').primaryKey(),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    occSymbol: text('occ_symbol').notNull(),
    expiration: timestamp('expiration', { withTimezone: true }).notNull(),
    strike: doublePrecision('strike').notNull(),
    right: optionRightEnum('right').notNull(),
  },
  (t) => [
    uniqueIndex('option_contracts_occ_key').on(t.occSymbol),
    index('option_contracts_lookup_idx').on(t.symbolId, t.expiration, t.right),
  ],
);

/**
 * Current snapshot only - one row per contract, upserted each cycle.
 * See the file header for why history is not retained here.
 */
export const optionQuotes = pgTable(
  'option_quotes',
  {
    contractId: integer('contract_id')
      .primaryKey()
      .references(() => optionContracts.id, { onDelete: 'cascade' }),

    /** Null means "not quoted", never zero. */
    bid: doublePrecision('bid'),
    ask: doublePrecision('ask'),
    last: doublePrecision('last'),
    volume: doublePrecision('volume'),
    openInterest: doublePrecision('open_interest'),

    impliedVolatility: doublePrecision('implied_volatility'),

    delta: doublePrecision('delta'),
    gamma: doublePrecision('gamma'),
    theta: doublePrecision('theta'),
    vega: doublePrecision('vega'),
    rho: doublePrecision('rho'),
    /** Prevents vendor and locally-derived Greeks being compared as equals. */
    greeksSource: greeksSourceEnum('greeks_source').notNull(),

    source: text('source').notNull(),
    delayedByMinutes: integer('delayed_by_minutes'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('option_quotes_fetched_idx').on(t.fetchedAt)],
);

/**
 * Daily ATM implied volatility, accumulated from first run.
 *
 * This table is the entire mechanism by which IV Rank becomes possible: no free
 * provider supplies historical IV, so it must be recorded going forward. Until
 * the window is long enough, scanners use `hv20` alongside it as the IV/HV
 * ratio and the IV-Rank filter stays disabled.
 */
export const ivHistory = pgTable(
  'iv_history',
  {
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    /** ~30-day at-the-money implied volatility. */
    atmIv30: doublePrecision('atm_iv_30').notNull(),
    hv20: doublePrecision('hv20'),
  },
  (t) => [primaryKey({ columns: [t.symbolId, t.date] })],
);

export const earnings = pgTable(
  'earnings',
  {
    id: serial('id').primaryKey(),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    earningsDate: timestamp('earnings_date', { withTimezone: true }).notNull(),
    /** Surfaced in the UI: acting on a guessed date differs from a confirmed one. */
    isEstimate: boolean('is_estimate').notNull(),
    timing: earningsTimingEnum('timing').notNull().default('unknown'),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('earnings_symbol_date_key').on(t.symbolId, t.earningsDate)],
);

export const riskFreeRates = pgTable(
  'risk_free_rates',
  {
    date: date('date').notNull(),
    tenorDays: integer('tenor_days').notNull(),
    rate: doublePrecision('rate').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.tenorDays] })],
);

export const marketRegimes = pgTable('market_regimes', {
  id: serial('id').primaryKey(),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  regime: regimeEnum('regime').notNull(),
  score: doublePrecision('score').notNull(),
  vix: doublePrecision('vix'),
  vixChange5d: doublePrecision('vix_change_5d'),
  breadth: doublePrecision('breadth'),
  /** Per-condition detail, so the dashboard can explain the classification. */
  components: jsonb('components').notNull(),
});

export const strategyConfigs = pgTable(
  'strategy_configs',
  {
    id: serial('id').primaryKey(),
    strategy: strategyEnum('strategy').notNull(),
    name: text('name').notNull(),
    /** Filters and score weights; deliberately not hard-coded in the engine. */
    params: jsonb('params').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('strategy_configs_name_key').on(t.strategy, t.name)],
);

export const scanRuns = pgTable('scan_runs', {
  id: serial('id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: scanStatusEnum('status').notNull(),
  universeId: integer('universe_id').references(() => universes.id),
  symbolsScanned: integer('symbols_scanned').notNull().default(0),
  contractsEvaluated: integer('contracts_evaluated').notNull().default(0),
  opportunitiesFound: integer('opportunities_found').notNull().default(0),
  /** Per-symbol failures, so a partial scan is auditable rather than silent. */
  errors: jsonb('errors'),
});

export const opportunities = pgTable(
  'opportunities',
  {
    id: serial('id').primaryKey(),
    scanRunId: integer('scan_run_id')
      .notNull()
      .references(() => scanRuns.id, { onDelete: 'cascade' }),
    strategy: strategyEnum('strategy').notNull(),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),

    shortContractId: integer('short_contract_id')
      .notNull()
      .references(() => optionContracts.id, { onDelete: 'cascade' }),
    /** Null for single-leg strategies (CSP, CC). */
    longContractId: integer('long_contract_id').references(
      () => optionContracts.id,
      { onDelete: 'cascade' },
    ),

    score: doublePrecision('score').notNull(),
    /**
     * Persisted per-component contributions. Storing rather than recomputing is
     * what makes the score explainable AND stable: the detail page renders what
     * the engine actually computed, so it can never disagree with the ranking.
     */
    scoreBreakdown: jsonb('score_breakdown').notNull(),
    metrics: jsonb('metrics').notNull(),
    positiveFactors: jsonb('positive_factors').notNull(),
    negativeFactors: jsonb('negative_factors').notNull(),

    /** Three separate stamps: these are fetched on different cadences. */
    marketDataAt: timestamp('market_data_at', { withTimezone: true }).notNull(),
    optionsDataAt: timestamp('options_data_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('opportunities_rank_idx').on(t.scanRunId, t.strategy, t.score),
    index('opportunities_symbol_idx').on(t.symbolId),
  ],
);

export const holdings = pgTable(
  'holdings',
  {
    id: serial('id').primaryKey(),
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    shares: doublePrecision('shares').notNull(),
    costBasis: doublePrecision('cost_basis').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex('holdings_symbol_key').on(t.symbolId)],
);

export const watchlistItems = pgTable(
  'watchlist_items',
  {
    symbolId: integer('symbol_id')
      .notNull()
      .references(() => symbols.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.symbolId] })],
);

export const providerHealth = pgTable(
  'provider_health',
  {
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    status: providerStatusEnum('status').notNull(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Taxonomy kind, so the UI can distinguish rate-limited from down. */
    lastErrorKind: text('last_error_kind'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.provider, t.operation] })],
);
