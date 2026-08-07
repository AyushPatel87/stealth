import { describe, expect, it } from 'vitest';
import { normCdf, normInv, normPdf } from './normal.js';

/**
 * Reference values were generated independently from this implementation using
 * Python's `math.erfc` (CPython delegates to the platform libm, correctly
 * rounded to ~1 ulp), via N(x) = 0.5 * erfc(-x / sqrt(2)). They are therefore a
 * genuine external oracle rather than a snapshot of our own output.
 */
const CDF_CASES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5],
  [0.5, 0.69146246127401312],
  [1, 0.84134474606854293],
  [-1, 0.15865525393145707],
  [1.96, 0.97500210485177952],
  [-1.96, 0.024997895148220435],
  [2, 0.97724986805182079],
  [-2, 0.022750131948179219],
  [3, 0.9986501019683699],
  [-3, 0.0013498980316300957],
  [5, 0.99999971334842808],
  [-5, 2.866515718791946e-7],
  [7.5, 0.99999999999996814],
  [-7.5, 3.1908916729109197e-14],
  [0.25, 0.5987063256829237],
  [-0.25, 0.4012936743170763],
];

const PDF_CASES: ReadonlyArray<readonly [number, number]> = [
  [0, 0.3989422804014327],
  [1, 0.24197072451914337],
  [-1, 0.24197072451914337],
  [2, 0.053990966513188063],
  [0.5, 0.35206532676429952],
];

const INV_CASES: ReadonlyArray<readonly [number, number]> = [
  [0.05, -1.6448536269514729],
  [0.95, 1.6448536269514715],
  [0.01, -2.3263478740408416],
  [0.99, 2.326347874040839],
  [0.1, -1.2815515655446008],
  [0.9, 1.2815515655446004],
  [0.025, -1.9599639845400545],
  [0.975, 1.9599639845400532],
  [0.0001, -3.7190164854556809],
  [0.9999, 3.7190164854555681],
];

describe('normCdf', () => {
  it.each(CDF_CASES)('N(%f) = %f', (x, expected) => {
    expect(normCdf(x)).toBeCloseTo(expected, 12);

    // Relative tolerance, banded to the measured accuracy of Hart's
    // approximation. Absolute error is not a useful metric in the tail, where
    // N(x) is itself ~1e-7 or smaller.
    if (expected > 0) {
      const absX = Math.abs(x);
      const tolerance = absX <= 3 ? 1e-13 : absX <= 5 ? 1e-10 : 1e-8;
      expect(Math.abs(normCdf(x) / expected - 1)).toBeLessThan(tolerance);
    }
  });

  it('is accurate in the deep tail where CSP deltas live', () => {
    // A 0.05-delta short put sits near N(-1.64). Relative accuracy here drives
    // probability-OTM display and delta-band filtering.
    const rel = Math.abs(normCdf(-1.6448536269514729) / 0.05 - 1);
    expect(rel).toBeLessThan(1e-12);
  });

  it('saturates without overflow far from the mean', () => {
    expect(normCdf(40)).toBe(1);
    expect(normCdf(-40)).toBe(0);
    expect(normCdf(1e308)).toBe(1);
    expect(normCdf(-1e308)).toBe(0);
  });

  it('is symmetric: N(-x) = 1 - N(x)', () => {
    for (const x of [0.1, 0.7, 1.3, 2.4, 3.9, 6.2]) {
      expect(normCdf(-x)).toBeCloseTo(1 - normCdf(x), 15);
    }
  });

  it('is monotonically non-decreasing', () => {
    let prev = -Infinity;
    for (let x = -8; x <= 8; x += 0.05) {
      const v = normCdf(x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('propagates NaN', () => {
    expect(normCdf(Number.NaN)).toBeNaN();
  });
});

describe('normPdf', () => {
  it.each(PDF_CASES)('phi(%f) = %f', (x, expected) => {
    expect(normPdf(x)).toBeCloseTo(expected, 15);
  });

  it('is symmetric', () => {
    expect(normPdf(-2.5)).toBe(normPdf(2.5));
  });

  it('underflows to zero rather than producing NaN', () => {
    expect(normPdf(1000)).toBe(0);
  });
});

describe('normInv', () => {
  it.each(INV_CASES)('invNorm(%f) = %f', (p, expected) => {
    expect(normInv(p)).toBeCloseTo(expected, 10);
  });

  it('returns 0 at the median', () => {
    expect(normInv(0.5)).toBeCloseTo(0, 12);
  });

  it('round-trips against normCdf', () => {
    for (const p of [0.001, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 12);
    }
  });

  it('handles the boundaries and rejects out-of-range input', () => {
    expect(normInv(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(normInv(1)).toBe(Number.POSITIVE_INFINITY);
    expect(normInv(-0.1)).toBeNaN();
    expect(normInv(1.1)).toBeNaN();
    expect(normInv(Number.NaN)).toBeNaN();
  });
});
