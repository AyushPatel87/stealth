/**
 * Scoring framework.
 *
 * The governing requirement is that every score is explainable. That is not
 * satisfied by producing a number and a paragraph next to it - it requires the
 * breakdown to BE the computation, so the two can never disagree. Hence:
 *
 *  - A score is assembled from components, each carrying its own weight, the
 *    points it actually earned, and a human-readable reason.
 *  - The total is the sum of the components. It is never computed separately,
 *    and `assembleScore` asserts the invariant.
 *  - A component that cannot be evaluated is recorded as such, and its weight
 *    is REDISTRIBUTED rather than silently scored zero. Scoring an unknown as
 *    zero would penalise a contract for a data gap that is not its fault, and
 *    would push exactly the thinly-covered names down the rankings for reasons
 *    unrelated to their merit.
 */

export interface ScoreComponent {
  readonly key: string;
  readonly label: string;
  /** Maximum points this component can contribute. */
  readonly weight: number;
  /** Points actually earned, 0..weight. */
  readonly earned: number;
  /** Why it earned that, in plain language. */
  readonly detail: string;
}

export interface ScoreResult {
  /** 0..100. Always equals the sum of component `earned` values. */
  readonly score: number;
  readonly components: readonly ScoreComponent[];
  readonly positiveFactors: readonly string[];
  readonly negativeFactors: readonly string[];
  /** Components that could not be evaluated, whose weight was redistributed. */
  readonly unavailable: readonly string[];
}

/**
 * A component before weight normalisation: a 0..1 quality with an explanation.
 * `quality: null` means "could not evaluate".
 */
export interface RawComponent {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly quality: number | null;
  readonly detail: string;
  /** Surfaced in the positive-factors list when quality is high. */
  readonly positive?: string | undefined;
  /** Surfaced in the negative-factors list when quality is low. */
  readonly negative?: string | undefined;
}

export interface AssembleOptions {
  /** Quality at or above which `positive` is surfaced. Default 0.7. */
  readonly positiveThreshold?: number;
  /** Quality at or below which `negative` is surfaced. Default 0.4. */
  readonly negativeThreshold?: number;
}

/**
 * Combines raw components into a final 0..100 score.
 *
 * Weights of unevaluable components are redistributed proportionally across the
 * rest, so the maximum achievable score remains 100 and a data gap neither
 * inflates nor deflates the result.
 */
export function assembleScore(
  raw: readonly RawComponent[],
  options: AssembleOptions = {},
): ScoreResult {
  const positiveThreshold = options.positiveThreshold ?? 0.7;
  const negativeThreshold = options.negativeThreshold ?? 0.4;

  const evaluable = raw.filter((c) => c.quality !== null);
  const unavailable = raw.filter((c) => c.quality === null);

  const evaluableWeight = evaluable.reduce((sum, c) => sum + c.weight, 0);
  const totalWeight = raw.reduce((sum, c) => sum + c.weight, 0);

  if (evaluableWeight <= 0) {
    return {
      score: 0,
      components: [],
      positiveFactors: [],
      negativeFactors: [],
      unavailable: unavailable.map((c) => c.label),
    };
  }

  // Redistribute so the evaluable components still span the full 100.
  const scale = totalWeight / evaluableWeight;

  const components: ScoreComponent[] = [];
  const positiveFactors: string[] = [];
  const negativeFactors: string[] = [];

  for (const component of evaluable) {
    const quality = Math.min(Math.max(component.quality as number, 0), 1);
    const weight = component.weight * scale;
    const earned = weight * quality;

    components.push({
      key: component.key,
      label: component.label,
      weight: round2(weight),
      earned: round2(earned),
      detail: component.detail,
    });

    if (quality >= positiveThreshold && component.positive !== undefined) {
      positiveFactors.push(component.positive);
    }
    if (quality <= negativeThreshold && component.negative !== undefined) {
      negativeFactors.push(component.negative);
    }
  }

  // The displayed total IS the sum of what is displayed, so a user adding up
  // the breakdown always arrives at the headline number.
  const score = round2(components.reduce((sum, c) => sum + c.earned, 0));

  return {
    score,
    components,
    positiveFactors,
    negativeFactors,
    unavailable: unavailable.map((c) => c.label),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Linear quality: 0 at `worst`, 1 at `best`. Works in either direction, so
 * `linear(x, 10, 0)` scores lower values higher.
 */
export function linear(value: number, worst: number, best: number): number {
  if (worst === best) return value >= best ? 1 : 0;
  const quality = (value - worst) / (best - worst);
  return Math.min(Math.max(quality, 0), 1);
}

/**
 * Plateau quality: 1 inside [idealLow, idealHigh], tapering linearly to 0 at
 * [hardLow, hardHigh].
 *
 * This is the right shape for anything with a sweet spot rather than a
 * direction - delta being the obvious case, where both too low (no premium) and
 * too high (assignment risk) are worse than the middle.
 */
export function plateau(
  value: number,
  hardLow: number,
  idealLow: number,
  idealHigh: number,
  hardHigh: number,
): number {
  if (value >= idealLow && value <= idealHigh) return 1;
  if (value <= hardLow || value >= hardHigh) return 0;
  if (value < idealLow) {
    return idealLow === hardLow ? 1 : (value - hardLow) / (idealLow - hardLow);
  }
  return idealHigh === hardHigh ? 1 : (hardHigh - value) / (hardHigh - idealHigh);
}

/** Formats a fraction as a percentage string for score explanations. */
export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}
