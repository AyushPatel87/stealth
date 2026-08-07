export {
  blackScholes,
  blackScholesPrice,
  rawGreeks,
  bsmLimitations,
  type BsmInputs,
  type BsmResult,
  type Greeks,
  type OptionRight,
} from './black-scholes.js';

export {
  impliedVolatility,
  priceBounds,
  type ImpliedVolInputs,
  type ImpliedVolResult,
  type ImpliedVolOutcome,
  type ImpliedVolFailure,
} from './implied-volatility.js';

export {
  expirationInstant,
  daysToExpiry,
  calendarDte,
  yearsToExpiry,
  DAYS_PER_YEAR,
} from './expiry.js';

export {
  premiumEstimate,
  distanceOtm,
  moneyness,
  premiumYield,
  annualizedYield,
  expectedMoveFromIv,
  expectedMoveFromStraddle,
  shortOptionBreakeven,
  sigmasFromSpot,
  type ContractQuote,
  type PremiumEstimate,
  type PremiumSource,
  type ExpectedMove,
} from './metrics.js';

export {
  verticalCreditSpread,
  probabilityOfProfit,
  approximateExpectedValue,
  type SpreadKind,
  type VerticalSpreadInput,
  type VerticalSpreadMetrics,
  type SpreadOutcome,
  type SpreadRejection,
  type ProbabilityOfProfitInputs,
} from './spreads.js';
