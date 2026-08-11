/**
 * IV Rank, IV Percentile, and the IV/HV substitute.
 *
 * THE COLD-START PROBLEM
 * ----------------------
 * IV Rank is defined over 52 weeks of historical implied volatility. No free
 * data provider supplies historical IV - it is not merely awkward to obtain,
 * it does not exist in any free feed. The application therefore records ATM IV
 * daily from first run and computes the rank over whatever window it actually
 * has.
 *
 * That creates a specific hazard this module is built to prevent: a rank
 * computed over eleven days looks exactly like a rank computed over a year, and
 * is far less meaningful. So `IvRankResult` always reports the window it used
 * and whether that window is sufficient, and a caller that ignores
 * `sufficient` gets a null rank rather than a confident-looking number.
 *
 * Until sufficiency is reached, `ivHvRatio` is the intended stand-in. It
 * answers a similar question - is this option expensive relative to how the
 * stock actually moves - from data available on day one.
 */

export interface IvObservation {
  /** ISO `YYYY-MM-DD`. */
  readonly date: string;
  /** At-the-money implied volatility as a decimal. */
  readonly iv: number;
}

export interface IvRankOptions {
  /**
   * Observations required before a rank is considered meaningful.
   *
   * 60 trading days is roughly a quarter: long enough to have seen a
   * volatility cycle, short enough that the scanner becomes useful within a few
   * months of first run rather than after a full year.
   */
  readonly minObservations?: number;
  /** Trailing window to rank within. 252 trading days approximates 52 weeks. */
  readonly windowSize?: number;
}

export interface IvRankResult {
  /**
   * Position within the observed high-low range, 0..100.
   * Null when there is insufficient history - never a fabricated value.
   */
  readonly rank: number | null;
  /**
   * Fraction of observations below the current IV, 0..100. More robust than
   * rank when a single spike distorts the range.
   */
  readonly percentile: number | null;
  /** Observations actually used. Display this alongside the rank. */
  readonly windowDays: number;
  /** Whether `windowDays` meets `minObservations`. */
  readonly sufficient: boolean;
  readonly minObservations: number;
  readonly low: number | null;
  readonly high: number | null;
}

export const DEFAULT_MIN_IV_OBSERVATIONS = 60;
export const DEFAULT_IV_WINDOW = 252;

/**
 * Computes IV Rank and IV Percentile over the available history.
 *
 * Returns nulls with `sufficient: false` rather than a rank derived from too
 * little data. A caller must decide explicitly to proceed.
 */
export function ivRank(
  currentIv: number,
  history: readonly IvObservation[],
  options: IvRankOptions = {},
): IvRankResult {
  const minObservations = options.minObservations ?? DEFAULT_MIN_IV_OBSERVATIONS;
  const windowSize = options.windowSize ?? DEFAULT_IV_WINDOW;

  const usable = history
    .filter((o) => Number.isFinite(o.iv) && o.iv > 0)
    .slice(-windowSize);

  const windowDays = usable.length;
  const sufficient = windowDays >= minObservations;

  if (!sufficient || !Number.isFinite(currentIv) || currentIv <= 0) {
    return {
      rank: null,
      percentile: null,
      windowDays,
      sufficient,
      minObservations,
      low: null,
      high: null,
    };
  }

  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let below = 0;

  for (const observation of usable) {
    if (observation.iv < low) low = observation.iv;
    if (observation.iv > high) high = observation.iv;
    if (observation.iv < currentIv) below += 1;
  }

  // A perfectly flat history has no range to rank within; 50 is the neutral
  // reading, and is honest rather than a division by zero.
  const range = high - low;
  const rank = range > 0 ? ((currentIv - low) / range) * 100 : 50;

  return {
    // Current IV can sit outside the historical range; clamp so the figure
    // stays interpretable as a percentage.
    rank: Math.min(Math.max(rank, 0), 100),
    percentile: (below / windowDays) * 100,
    windowDays,
    sufficient,
    minObservations,
    low,
    high,
  };
}

export interface IvHvRatioResult {
  /** Implied divided by realised volatility. */
  readonly ratio: number | null;
  /**
   * Premium of implied over realised, as a fraction. 0.25 means options are
   * priced 25% above the stock's recent realised movement.
   */
  readonly premium: number | null;
  readonly impliedVolatility: number;
  readonly historicalVolatility: number | null;
}

/**
 * The day-one substitute for IV Rank.
 *
 * Computable immediately from data the pipeline already has, and answers a
 * related question: is this option expensive relative to how the underlying
 * actually moves? Values meaningfully above 1 indicate implied volatility is
 * being paid at a premium to realised, which is the condition a premium seller
 * wants.
 *
 * It is NOT a drop-in replacement for IV Rank - it is cross-sectional rather
 * than historical, so it says nothing about whether this name's IV is high
 * relative to its own past. Both are reported separately rather than blended.
 */
export function ivHvRatio(
  impliedVolatility: number,
  historicalVolatility: number | null,
): IvHvRatioResult {
  if (
    historicalVolatility === null ||
    !Number.isFinite(historicalVolatility) ||
    historicalVolatility <= 0 ||
    !Number.isFinite(impliedVolatility) ||
    impliedVolatility <= 0
  ) {
    return {
      ratio: null,
      premium: null,
      impliedVolatility,
      historicalVolatility,
    };
  }

  const ratio = impliedVolatility / historicalVolatility;
  return {
    ratio,
    premium: ratio - 1,
    impliedVolatility,
    historicalVolatility,
  };
}

/**
 * Human-readable description of the volatility richness signal actually in use,
 * so the UI never displays a bare number whose provenance is ambiguous.
 */
export function volatilityRichnessLabel(
  rank: IvRankResult,
  ratio: IvHvRatioResult,
): string {
  if (rank.sufficient && rank.rank !== null) {
    return `IV Rank ${rank.rank.toFixed(0)} (${rank.windowDays}d window)`;
  }
  if (ratio.ratio !== null) {
    return `IV/HV ${ratio.ratio.toFixed(2)} (IV Rank needs ${
      rank.minObservations - rank.windowDays
    } more days)`;
  }
  return 'Volatility richness unavailable';
}
