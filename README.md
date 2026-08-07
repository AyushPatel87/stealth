# Stealth — Options Opportunity Scanner

Scans the US equity options market for cash-secured puts, covered calls, put
credit spreads and call credit spreads; scores and ranks them; and explains
every score.

Research and decision-support only. It does not connect to a brokerage and
places no trades.

## Status

| Milestone | State |
|---|---|
| M0 — monorepo baseline | done |
| M1 — domain engine (pricing, Greeks, IV, metrics, spreads, indicators) | done, 214 tests |
| M2 — provider abstraction + Yahoo | next |
| M3 — options provider (Alpaca) | pending |
| M4-M12 | pending |

## Requirements

- Node >= 22
- pnpm 10
- PostgreSQL 16 (from M4 onward)

## Getting started

```bash
pnpm install
pnpm test        # 214 unit tests, no network required
pnpm typecheck
```

## Layout

```
packages/core     Pure domain engine. No I/O, no network, no database.
                  Everything here is deterministic and unit-testable offline.
packages/data     Providers, normalisation, persistence.        (M2+)
apps/worker       Scheduler and scan pipeline.                  (M4+)
apps/web          Next.js UI. Reads the database; never calls a provider.  (M8+)
```

`packages/core` importing no I/O is enforced by convention and review, and is
what keeps financial calculations out of React components.

## Design decisions worth knowing

These were derived from measurement, not assumption. Each is documented in full
at the point of implementation.

**Yahoo provides implied volatility but no Greeks.** Verified against the
generated JSON schema shipped in `yahoo-finance2@4.0.1`: exactly 15 fields per
contract, `impliedVolatility` required, no delta/gamma/theta/vega. All Greeks
are therefore computed locally from Black-Scholes-Merton. `bid`, `ask`, `volume`
and `openInterest` are *optional* in that schema — thin contracts omit the keys
entirely — so normalisation handles absence, not just null.

**Greek unit conventions are fixed and explicit.** Theta per calendar day, vega
per volatility point, rho per percentage point. Mixing conventions is the most
common silent error in options tooling, so `rawGreeks()` exposes the unscaled
per-annum values separately rather than leaving the scaling ambiguous.

**Implied volatility is not always recoverable.** For deep in-the-money
contracts the price is entirely intrinsic and carries no volatility information
— a 30-point-ITM 7-DTE call prices identically at the bit level for 8% and 20%
volatility, with vega around 1e-226. The solver detects this and returns
`not-identifiable` rather than inventing a number. The threshold (extrinsic
value > 1e-8 of price) was measured across a 533-case grid, where it caps
recovery error at 5.8e-10.

**Probability of profit is measured from break-even, not the short strike.**
The credit received cushions the position, and conflating the two understates
every credit spread by several percentage points — enough to reorder rankings.
Relatedly, delta is *not* probability-ITM: for puts it understates assignment
risk, for calls it overstates it.

**Credit spreads are validated, not assumed.** Candidates are generated
combinatorially, so most leg pairings are nonsense. The critical guard rejects a
credit exceeding the spread width: that never means free money, it means a stale
quote, and unchecked it produces a negative max loss and infinite return on risk
that would pin the spread permanently at the top of the rankings.

**Indicators run on split-adjusted close, not dividend-adjusted.** Strikes are
quoted against actual traded prices, so a dividend-adjusted 200 EMA would drift
below the series it is compared against by the cumulative yield over the
lookback — enough to flip a "price above 200 EMA" filter on a 3%-yielding name.

**Expirations resolve to UTC instants at 16:00 America/New_York.** DST is
handled, and time to expiry measures real elapsed time: two "Friday 16:00 ET"
expirations spanning a spring-forward are 335 hours apart, not 336. Theta decays
in real time.

**Missing indicators stay null.** A newly-listed name genuinely has no 200 EMA.
Substituting a shorter average would most distort exactly the thinly-traded
names that carry the most risk, so trend assessment reports `complete: false`
instead.

## Known limitations

Surfaced deliberately rather than hidden; `bsmLimitations()` returns these
machine-readably for display in the UI.

- **European exercise assumed.** US equity options are American. The difference
  is negligible for the out-of-the-money strikes this scanner targets, but real
  for in-the-money puts on dividend payers. Bjerksund-Stensland is the intended
  upgrade.
- **Probabilities are risk-neutral**, not real-world forecasts.
- **Constant volatility per contract**; the strike skew is not modelled, so
  spread probabilities use the short leg's IV for both legs.
- **IV Rank needs history that no free source provides.** It is accumulated from
  first run, displayed with its window length, and the filter is auto-disabled
  until enough history exists. IV/HV ratio serves as the day-one substitute.
- **Data is ~15 minutes delayed**, and open interest is previous-day close
  across all OPRA-derived sources.
