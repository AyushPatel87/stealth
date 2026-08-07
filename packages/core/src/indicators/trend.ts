/**
 * Trend classification from the moving-average stack.
 *
 * Returns both a discrete label (for display) and a continuous score (for
 * scoring), because a scanner that only had the label would treat a stock
 * barely above its 50 EMA identically to one riding a clean stack - and those
 * are very different risks for a put seller.
 */

export type TrendLabel =
  | 'strong-uptrend'
  | 'uptrend'
  | 'neutral'
  | 'downtrend'
  | 'strong-downtrend';

export interface TrendInputs {
  readonly price: number;
  readonly ema20: number | null;
  readonly ema50: number | null;
  readonly ema100: number | null;
  readonly ema200: number | null;
}

export interface TrendAssessment {
  readonly label: TrendLabel;
  /** -100 (maximally bearish) to +100 (maximally bullish). */
  readonly score: number;
  /** Human-readable conditions that fired, for score explainability. */
  readonly reasons: readonly string[];
  /** True when every requested average was available. */
  readonly complete: boolean;
}

/**
 * Classifies trend by scoring independent conditions and mapping the total onto
 * a label. Missing averages (a newly-listed name has no 200 EMA) reduce the
 * available score rather than defaulting to bullish or bearish, and are
 * reported through `complete` so callers can down-weight the result.
 */
export function classifyTrend(inputs: TrendInputs): TrendAssessment {
  const { price, ema20, ema50, ema100, ema200 } = inputs;
  const reasons: string[] = [];

  let score = 0;
  let available = 0;

  const record = (
    condition: boolean | null,
    weight: number,
    positive: string,
    negative: string,
  ): void => {
    if (condition === null) return;
    available += weight;
    if (condition) {
      score += weight;
      reasons.push(positive);
    } else {
      score -= weight;
      reasons.push(negative);
    }
  };

  record(
    ema200 === null ? null : price > ema200,
    35,
    'Price above 200 EMA',
    'Price below 200 EMA',
  );
  record(
    ema50 === null ? null : price > ema50,
    25,
    'Price above 50 EMA',
    'Price below 50 EMA',
  );
  record(
    ema20 === null ? null : price > ema20,
    15,
    'Price above 20 EMA',
    'Price below 20 EMA',
  );
  record(
    ema50 === null || ema200 === null ? null : ema50 > ema200,
    15,
    '50 EMA above 200 EMA',
    '50 EMA below 200 EMA',
  );
  record(
    ema20 === null || ema50 === null ? null : ema20 > ema50,
    10,
    '20 EMA above 50 EMA',
    '20 EMA below 50 EMA',
  );

  const complete =
    ema20 !== null && ema50 !== null && ema100 !== null && ema200 !== null;

  // Normalise to -100..100 against the weight actually available, so a name
  // missing its 200 EMA is not automatically scored as neutral.
  const normalised = available > 0 ? (score / available) * 100 : 0;

  return {
    label: labelFor(normalised),
    score: normalised,
    reasons,
    complete,
  };
}

function labelFor(score: number): TrendLabel {
  if (score >= 75) return 'strong-uptrend';
  if (score >= 25) return 'uptrend';
  if (score > -25) return 'neutral';
  if (score > -75) return 'downtrend';
  return 'strong-downtrend';
}
