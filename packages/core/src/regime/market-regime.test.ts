import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGIME_BIAS,
  DEFAULT_REGIME_THRESHOLDS,
  DEFAULT_REGIME_WEIGHTS,
  classifyMarketRegime,
  regimeMultiplier,
  type RegimeInputs,
} from './market-regime.js';

const bullish: RegimeInputs = {
  spy: { price: 600, ema20: 595, ema50: 585, ema200: 550 },
  qqq: { price: 520, ema20: 515, ema50: 505, ema200: 470 },
  vix: { level: 14, change5d: -1.2 },
  breadth: 0.68,
};

const bearish: RegimeInputs = {
  spy: { price: 500, ema20: 510, ema50: 525, ema200: 545 },
  qqq: { price: 420, ema20: 430, ema50: 445, ema200: 470 },
  vix: { level: 22, change5d: 2.4 },
  breadth: 0.31,
};

describe('classifyMarketRegime', () => {
  it('classifies a clean bullish tape', () => {
    const r = classifyMarketRegime(bullish);
    expect(r.label).toBe('bullish');
    expect(r.score).toBe(100);
    expect(r.volatilityOverride).toBe(false);
    expect(r.missing).toEqual([]);
  });

  it('classifies a clean bearish tape', () => {
    const r = classifyMarketRegime(bearish);
    expect(r.label).toBe('bearish');
    expect(r.score).toBe(-100);
  });

  it('reports every condition so the dashboard can explain the verdict', () => {
    const r = classifyMarketRegime(bullish);
    const keys = r.components.map((c) => c.key);
    expect(keys).toEqual([
      'spyAbove20',
      'spyAbove50',
      'spyAbove200',
      'spy50Above200',
      'qqqAbove50',
      'vixFalling',
      'breadth',
    ]);
    for (const component of r.components) {
      expect(component.label.length).toBeGreaterThan(0);
      expect(Math.abs(component.contribution)).toBe(component.weight);
    }
  });

  it('sums component contributions to the raw score', () => {
    const r = classifyMarketRegime(bearish);
    const total = r.components.reduce((sum, c) => sum + c.contribution, 0);
    const available = r.components.reduce((sum, c) => sum + c.weight, 0);
    expect((total / available) * 100).toBeCloseTo(r.score, 9);
  });

  it('treats high VIX as an override orthogonal to direction', () => {
    // A violent rally is still dangerous for a premium seller; a directional
    // score cannot express that, so the override sits outside the axis.
    const violentRally = {
      ...bullish,
      vix: { level: 34, change5d: -3 },
    };
    const r = classifyMarketRegime(violentRally);

    expect(r.label).toBe('high-volatility');
    expect(r.volatilityOverride).toBe(true);
    // The underlying direction is preserved for display alongside it.
    expect(r.directionalLabel).toBe('bullish');
    expect(r.score).toBeGreaterThan(0);
  });

  it('fires the override in a bearish tape too', () => {
    const r = classifyMarketRegime({ ...bearish, vix: { level: 40, change5d: 8 } });
    expect(r.label).toBe('high-volatility');
    expect(r.directionalLabel).toBe('bearish');
  });

  it('reports neutral for a mixed tape', () => {
    const r = classifyMarketRegime({
      spy: { price: 560, ema20: 565, ema50: 555, ema200: 540 },
      qqq: { price: 480, ema20: 485, ema50: 490, ema200: 460 },
      vix: { level: 18, change5d: 0.3 },
      breadth: 0.5,
    });
    expect(r.label).toBe('neutral');
    expect(Math.abs(r.score)).toBeLessThan(
      DEFAULT_REGIME_THRESHOLDS.bullish,
    );
  });

  it('reduces the denominator for missing data instead of scoring it neutral', () => {
    // A partially-observed market should not be dragged toward zero.
    const r = classifyMarketRegime({
      spy: { price: 600, ema20: 595, ema50: 585, ema200: 550 },
      qqq: null,
      vix: null,
    });

    expect(r.missing).toContain('qqqAbove50');
    expect(r.missing).toContain('vixFalling');
    expect(r.missing).toContain('breadth');
    // Every available condition is bullish, so it still reads +100.
    expect(r.score).toBe(100);
    expect(r.label).toBe('bullish');
  });

  it('never fires the volatility override when VIX is unavailable', () => {
    const r = classifyMarketRegime({ ...bullish, vix: null });
    expect(r.volatilityOverride).toBe(false);
    expect(r.label).toBe('bullish');
  });

  it('returns a neutral zero when nothing can be evaluated', () => {
    const r = classifyMarketRegime({
      spy: { price: 600, ema20: null, ema50: null, ema200: null },
      qqq: null,
      vix: null,
    });
    expect(r.score).toBe(0);
    expect(r.label).toBe('neutral');
    expect(r.components).toEqual([]);
  });

  it('honours custom weights rather than the defaults', () => {
    // Weights must be tunable; nothing downstream may assume the defaults.
    const spyOnly = {
      ...DEFAULT_REGIME_WEIGHTS,
      qqqAbove50: 0,
      vixFalling: 0,
      breadth: 0,
    };
    const r = classifyMarketRegime(
      {
        spy: { price: 600, ema20: 595, ema50: 585, ema200: 550 },
        qqq: { price: 400, ema20: 450, ema50: 470, ema200: 500 },
        vix: { level: 15, change5d: 5 },
        breadth: 0.1,
      },
      spyOnly,
    );
    // The bearish QQQ/VIX/breadth conditions carry zero weight.
    expect(r.score).toBe(100);
  });

  it('honours custom thresholds', () => {
    const strict = { ...DEFAULT_REGIME_THRESHOLDS, bullish: 95 };
    const mild: RegimeInputs = {
      spy: { price: 600, ema20: 595, ema50: 585, ema200: 550 },
      qqq: { price: 520, ema20: 515, ema50: 530, ema200: 470 },
      vix: { level: 14, change5d: -1 },
      breadth: 0.55,
    };
    expect(classifyMarketRegime(mild).label).toBe('bullish');
    expect(
      classifyMarketRegime(mild, DEFAULT_REGIME_WEIGHTS, strict).label,
    ).toBe('neutral');
  });

  it('lets the override threshold be configured', () => {
    const r = classifyMarketRegime(bullish, DEFAULT_REGIME_WEIGHTS, {
      ...DEFAULT_REGIME_THRESHOLDS,
      highVolatilityVix: 10,
    });
    expect(r.label).toBe('high-volatility');
  });
});

describe('regimeMultiplier', () => {
  it('favours put-selling in a bullish regime and call spreads in a bearish one', () => {
    expect(regimeMultiplier('bullish', 'CSP')).toBeGreaterThan(
      regimeMultiplier('bearish', 'CSP'),
    );
    expect(regimeMultiplier('bullish', 'PCS')).toBeGreaterThan(
      regimeMultiplier('bearish', 'PCS'),
    );
    expect(regimeMultiplier('bearish', 'CCS')).toBeGreaterThan(
      regimeMultiplier('bullish', 'CCS'),
    );
  });

  it('keeps covered calls comparatively regime-insensitive', () => {
    const spread = Math.abs(
      regimeMultiplier('bullish', 'CC') - regimeMultiplier('bearish', 'CC'),
    );
    const cspSpread = Math.abs(
      regimeMultiplier('bullish', 'CSP') - regimeMultiplier('bearish', 'CSP'),
    );
    expect(spread).toBeLessThan(cspSpread);
  });

  it('damps directional strategies under high volatility without favouring any', () => {
    const high = DEFAULT_REGIME_BIAS['high-volatility'];
    expect(high.CSP).toBeLessThan(DEFAULT_REGIME_BIAS.bullish.CSP);
    expect(high.CCS).toBeLessThan(DEFAULT_REGIME_BIAS.bearish.CCS);
    for (const value of Object.values(high)) {
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps every multiplier within [0, 1]', () => {
    for (const strategies of Object.values(DEFAULT_REGIME_BIAS)) {
      for (const value of Object.values(strategies)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('accepts a custom bias table', () => {
    const custom = {
      ...DEFAULT_REGIME_BIAS,
      bullish: { CSP: 0.1, PCS: 0.2, CC: 0.3, CCS: 0.4 },
    };
    expect(regimeMultiplier('bullish', 'CSP', custom)).toBe(0.1);
  });
});
