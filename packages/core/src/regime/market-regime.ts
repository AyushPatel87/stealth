/**
 * Market regime engine.
 *
 * Classifies the broad market so that strategy scoring can be biased toward
 * what the environment favours: a cash-secured put is a very different
 * proposition in a bullish drift than in a VIX-spiking downtrend, even when the
 * contract's own metrics are identical.
 *
 * Two design commitments:
 *
 *  1. WEIGHTS ARE CONFIGURABLE, not baked in. The defaults below are a starting
 *     point, not a claim about market structure, and they are expected to be
 *     tuned. Nothing downstream may hard-code them.
 *
 *  2. EVERY CONDITION IS REPORTED. The dashboard has to be able to say *why*
 *     the market is classified bearish, which means the per-condition
 *     contributions travel with the verdict rather than being recomputed.
 *
 * High volatility is treated as an OVERRIDE rather than a point on the
 * bullish-bearish axis, because it is orthogonal: a violent rally and a violent
 * selloff are both dangerous environments for a premium seller, and averaging
 * them into a directional score would hide exactly the risk that matters.
 */

export type RegimeLabel = 'bullish' | 'neutral' | 'bearish' | 'high-volatility';

export interface IndexSnapshot {
  readonly price: number;
  readonly ema20: number | null;
  readonly ema50: number | null;
  readonly ema200: number | null;
}

export interface VixSnapshot {
  readonly level: number;
  /** Change over the last five sessions, in VIX points. */
  readonly change5d: number | null;
}

export interface RegimeInputs {
  readonly spy: IndexSnapshot;
  readonly qqq: IndexSnapshot | null;
  readonly vix: VixSnapshot | null;
  /**
   * Fraction of the universe trading above its 200 EMA, 0..1. Optional because
   * it requires a full universe pass; when absent it simply contributes no
   * weight rather than a neutral guess.
   */
  readonly breadth?: number | null;
}

export interface RegimeWeights {
  readonly spyAbove20: number;
  readonly spyAbove50: number;
  readonly spyAbove200: number;
  readonly spy50Above200: number;
  readonly qqqAbove50: number;
  readonly vixFalling: number;
  readonly breadth: number;
}

export const DEFAULT_REGIME_WEIGHTS: RegimeWeights = {
  spyAbove20: 10,
  spyAbove50: 20,
  spyAbove200: 30,
  spy50Above200: 15,
  qqqAbove50: 15,
  vixFalling: 10,
  breadth: 10,
};

export interface RegimeThresholds {
  /** Score at or above which the market is bullish. */
  readonly bullish: number;
  /** Score at or below which the market is bearish. */
  readonly bearish: number;
  /**
   * VIX level above which the high-volatility override fires regardless of
   * direction.
   */
  readonly highVolatilityVix: number;
}

export const DEFAULT_REGIME_THRESHOLDS: RegimeThresholds = {
  bullish: 30,
  bearish: -30,
  highVolatilityVix: 28,
};

export interface RegimeComponent {
  readonly key: string;
  readonly label: string;
  /** Signed contribution actually applied. */
  readonly contribution: number;
  /** Weight that was available for this condition. */
  readonly weight: number;
  readonly passed: boolean;
}

export interface RegimeAssessment {
  readonly label: RegimeLabel;
  /** -100 (maximally bearish) to +100 (maximally bullish). */
  readonly score: number;
  readonly components: readonly RegimeComponent[];
  /** True when the high-volatility override displaced the directional label. */
  readonly volatilityOverride: boolean;
  /** Directional label before any override, for display alongside the override. */
  readonly directionalLabel: Exclude<RegimeLabel, 'high-volatility'>;
  /** Conditions that could not be evaluated for lack of data. */
  readonly missing: readonly string[];
}

/**
 * Classifies the market.
 *
 * Unavailable conditions reduce the denominator rather than scoring as neutral,
 * so a partially-observed market is not automatically pulled toward zero.
 */
export function classifyMarketRegime(
  inputs: RegimeInputs,
  weights: RegimeWeights = DEFAULT_REGIME_WEIGHTS,
  thresholds: RegimeThresholds = DEFAULT_REGIME_THRESHOLDS,
): RegimeAssessment {
  const components: RegimeComponent[] = [];
  const missing: string[] = [];
  let score = 0;
  let available = 0;

  const evaluate = (
    key: string,
    label: string,
    condition: boolean | null,
    weight: number,
  ): void => {
    if (condition === null) {
      missing.push(key);
      return;
    }
    available += weight;
    const contribution = condition ? weight : -weight;
    score += contribution;
    components.push({ key, label, contribution, weight, passed: condition });
  };

  const { spy, qqq, vix } = inputs;

  evaluate(
    'spyAbove20',
    'SPY above 20 EMA',
    spy.ema20 === null ? null : spy.price > spy.ema20,
    weights.spyAbove20,
  );
  evaluate(
    'spyAbove50',
    'SPY above 50 EMA',
    spy.ema50 === null ? null : spy.price > spy.ema50,
    weights.spyAbove50,
  );
  evaluate(
    'spyAbove200',
    'SPY above 200 EMA',
    spy.ema200 === null ? null : spy.price > spy.ema200,
    weights.spyAbove200,
  );
  evaluate(
    'spy50Above200',
    'SPY 50 EMA above 200 EMA',
    spy.ema50 === null || spy.ema200 === null ? null : spy.ema50 > spy.ema200,
    weights.spy50Above200,
  );
  evaluate(
    'qqqAbove50',
    'QQQ above 50 EMA',
    qqq === null || qqq.ema50 === null ? null : qqq.price > qqq.ema50,
    weights.qqqAbove50,
  );
  evaluate(
    'vixFalling',
    'VIX declining',
    vix === null || vix.change5d === null ? null : vix.change5d < 0,
    weights.vixFalling,
  );

  const breadth = inputs.breadth;
  evaluate(
    'breadth',
    'Majority of universe above 200 EMA',
    breadth === null || breadth === undefined ? null : breadth > 0.5,
    weights.breadth,
  );

  const normalised = available > 0 ? (score / available) * 100 : 0;

  const directionalLabel: Exclude<RegimeLabel, 'high-volatility'> =
    normalised >= thresholds.bullish
      ? 'bullish'
      : normalised <= thresholds.bearish
        ? 'bearish'
        : 'neutral';

  // Orthogonal override: a violent rally and a violent selloff are both
  // hazardous for a premium seller, and a directional score cannot express that.
  const volatilityOverride =
    vix !== null && vix.level >= thresholds.highVolatilityVix;

  return {
    label: volatilityOverride ? 'high-volatility' : directionalLabel,
    score: normalised,
    components,
    volatilityOverride,
    directionalLabel,
    missing,
  };
}

export type StrategyKey = 'CSP' | 'CC' | 'PCS' | 'CCS';

/**
 * Per-strategy score multipliers by regime.
 *
 * Applied to the market-regime component of an opportunity's score, NOT to the
 * whole score - regime is context, not a verdict on an individual contract.
 *
 * Defaults only. The specification is explicit that these must not be
 * permanently hard-coded, so they are data and are expected to be tuned and
 * persisted alongside the other strategy configuration.
 */
export type RegimeBias = Readonly<Record<RegimeLabel, Readonly<Record<StrategyKey, number>>>>;

export const DEFAULT_REGIME_BIAS: RegimeBias = {
  bullish: { CSP: 1.0, PCS: 1.0, CC: 0.75, CCS: 0.25 },
  neutral: { CSP: 0.7, PCS: 0.7, CC: 0.7, CCS: 0.7 },
  bearish: { CSP: 0.25, PCS: 0.25, CC: 0.7, CCS: 1.0 },
  // Elevated volatility raises premiums but also the chance of being run over.
  // Directional strategies are damped; nothing is favoured outright.
  'high-volatility': { CSP: 0.4, PCS: 0.4, CC: 0.6, CCS: 0.5 },
};

/** Multiplier in [0, 1] for a strategy under an assessed regime. */
export function regimeMultiplier(
  regime: RegimeLabel,
  strategy: StrategyKey,
  bias: RegimeBias = DEFAULT_REGIME_BIAS,
): number {
  return bias[regime][strategy];
}
