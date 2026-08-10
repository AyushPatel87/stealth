CREATE TYPE "public"."earnings_timing" AS ENUM('before-open', 'after-close', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."greeks_source" AS ENUM('provider', 'computed', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."option_right" AS ENUM('call', 'put');--> statement-breakpoint
CREATE TYPE "public"."provider_status" AS ENUM('healthy', 'degraded', 'down');--> statement-breakpoint
CREATE TYPE "public"."market_regime" AS ENUM('bullish', 'neutral', 'bearish', 'high-volatility');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('running', 'succeeded', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."strategy" AS ENUM('CSP', 'CC', 'PCS', 'CCS');--> statement-breakpoint
CREATE TYPE "public"."trend_label" AS ENUM('strong-uptrend', 'uptrend', 'neutral', 'downtrend', 'strong-downtrend');--> statement-breakpoint
CREATE TABLE "daily_bars" (
	"symbol_id" integer NOT NULL,
	"date" date NOT NULL,
	"open" double precision NOT NULL,
	"high" double precision NOT NULL,
	"low" double precision NOT NULL,
	"close" double precision NOT NULL,
	"adj_close" double precision,
	"volume" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_bars_symbol_id_date_pk" PRIMARY KEY("symbol_id","date")
);
--> statement-breakpoint
CREATE TABLE "earnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol_id" integer NOT NULL,
	"earnings_date" timestamp with time zone NOT NULL,
	"is_estimate" boolean NOT NULL,
	"timing" "earnings_timing" DEFAULT 'unknown' NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol_id" integer NOT NULL,
	"shares" double precision NOT NULL,
	"cost_basis" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indicators" (
	"symbol_id" integer PRIMARY KEY NOT NULL,
	"price" double precision NOT NULL,
	"bar_count" integer NOT NULL,
	"ema20" double precision,
	"ema50" double precision,
	"ema100" double precision,
	"ema200" double precision,
	"rsi14" double precision,
	"roc20" double precision,
	"return_1m" double precision,
	"return_3m" double precision,
	"atr14" double precision,
	"atr_percent_14" double precision,
	"hv20" double precision,
	"hv60" double precision,
	"trend" "trend_label" NOT NULL,
	"trend_score" double precision NOT NULL,
	"trend_complete" boolean NOT NULL,
	"support" double precision,
	"resistance" double precision,
	"week_52_high" double precision,
	"week_52_low" double precision,
	"vwap20" double precision,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iv_history" (
	"symbol_id" integer NOT NULL,
	"date" date NOT NULL,
	"atm_iv_30" double precision NOT NULL,
	"hv20" double precision,
	CONSTRAINT "iv_history_symbol_id_date_pk" PRIMARY KEY("symbol_id","date")
);
--> statement-breakpoint
CREATE TABLE "market_regimes" (
	"id" serial PRIMARY KEY NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"regime" "market_regime" NOT NULL,
	"score" double precision NOT NULL,
	"vix" double precision,
	"vix_change_5d" double precision,
	"breadth" double precision,
	"components" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"scan_run_id" integer NOT NULL,
	"strategy" "strategy" NOT NULL,
	"symbol_id" integer NOT NULL,
	"short_contract_id" integer NOT NULL,
	"long_contract_id" integer,
	"score" double precision NOT NULL,
	"score_breakdown" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"positive_factors" jsonb NOT NULL,
	"negative_factors" jsonb NOT NULL,
	"market_data_at" timestamp with time zone NOT NULL,
	"options_data_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol_id" integer NOT NULL,
	"occ_symbol" text NOT NULL,
	"expiration" timestamp with time zone NOT NULL,
	"strike" double precision NOT NULL,
	"right" "option_right" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "option_quotes" (
	"contract_id" integer PRIMARY KEY NOT NULL,
	"bid" double precision,
	"ask" double precision,
	"last" double precision,
	"volume" double precision,
	"open_interest" double precision,
	"implied_volatility" double precision,
	"delta" double precision,
	"gamma" double precision,
	"theta" double precision,
	"vega" double precision,
	"rho" double precision,
	"greeks_source" "greeks_source" NOT NULL,
	"source" text NOT NULL,
	"delayed_by_minutes" integer,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_health" (
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"status" "provider_status" NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"last_error_kind" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "provider_health_provider_operation_pk" PRIMARY KEY("provider","operation")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"symbol_id" integer PRIMARY KEY NOT NULL,
	"price" double precision NOT NULL,
	"previous_close" double precision,
	"open" double precision,
	"day_high" double precision,
	"day_low" double precision,
	"volume" double precision,
	"market_state" text DEFAULT 'unknown' NOT NULL,
	"source" text NOT NULL,
	"delayed_by_minutes" integer,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_free_rates" (
	"date" date NOT NULL,
	"tenor_days" integer NOT NULL,
	"rate" double precision NOT NULL,
	CONSTRAINT "risk_free_rates_date_tenor_days_pk" PRIMARY KEY("date","tenor_days")
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "scan_status" NOT NULL,
	"universe_id" integer,
	"symbols_scanned" integer DEFAULT 0 NOT NULL,
	"contracts_evaluated" integer DEFAULT 0 NOT NULL,
	"opportunities_found" integer DEFAULT 0 NOT NULL,
	"errors" jsonb
);
--> statement-breakpoint
CREATE TABLE "strategy_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"strategy" "strategy" NOT NULL,
	"name" text NOT NULL,
	"params" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"yahoo_ticker" text NOT NULL,
	"name" text,
	"sector" text,
	"exchange" text,
	"optionable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "universe_members" (
	"universe_id" integer NOT NULL,
	"symbol_id" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "universe_members_universe_id_symbol_id_pk" PRIMARY KEY("universe_id","symbol_id")
);
--> statement-breakpoint
CREATE TABLE "universes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_items" (
	"symbol_id" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_items_symbol_id_pk" PRIMARY KEY("symbol_id")
);
--> statement-breakpoint
ALTER TABLE "daily_bars" ADD CONSTRAINT "daily_bars_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "indicators" ADD CONSTRAINT "indicators_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iv_history" ADD CONSTRAINT "iv_history_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_scan_run_id_scan_runs_id_fk" FOREIGN KEY ("scan_run_id") REFERENCES "public"."scan_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_short_contract_id_option_contracts_id_fk" FOREIGN KEY ("short_contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_long_contract_id_option_contracts_id_fk" FOREIGN KEY ("long_contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_contracts" ADD CONSTRAINT "option_contracts_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_quotes" ADD CONSTRAINT "option_quotes_contract_id_option_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."option_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_runs" ADD CONSTRAINT "scan_runs_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_members" ADD CONSTRAINT "universe_members_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "universe_members" ADD CONSTRAINT "universe_members_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_items" ADD CONSTRAINT "watchlist_items_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "earnings_symbol_date_key" ON "earnings" USING btree ("symbol_id","earnings_date");--> statement-breakpoint
CREATE UNIQUE INDEX "holdings_symbol_key" ON "holdings" USING btree ("symbol_id");--> statement-breakpoint
CREATE INDEX "opportunities_rank_idx" ON "opportunities" USING btree ("scan_run_id","strategy","score");--> statement-breakpoint
CREATE INDEX "opportunities_symbol_idx" ON "opportunities" USING btree ("symbol_id");--> statement-breakpoint
CREATE UNIQUE INDEX "option_contracts_occ_key" ON "option_contracts" USING btree ("occ_symbol");--> statement-breakpoint
CREATE INDEX "option_contracts_lookup_idx" ON "option_contracts" USING btree ("symbol_id","expiration","right");--> statement-breakpoint
CREATE INDEX "option_quotes_fetched_idx" ON "option_quotes" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_configs_name_key" ON "strategy_configs" USING btree ("strategy","name");--> statement-breakpoint
CREATE UNIQUE INDEX "symbols_ticker_key" ON "symbols" USING btree ("ticker");--> statement-breakpoint
CREATE UNIQUE INDEX "universes_code_key" ON "universes" USING btree ("code");