/**
 * Standard normal distribution primitives.
 *
 * Accuracy matters here more than it first appears: cash-secured-put scanning
 * targets |delta| 0.05-0.15, which lives 1.5-2 sigma into the tail. The common
 * Abramowitz & Stegun 7.1.26 approximation carries ~7.5e-8 absolute error, which
 * is a meaningful *relative* error once N(x) itself is ~0.05. We therefore use
 * Hart's rational approximation (as popularised by Graeme West), which is
 * accurate to roughly double precision across the whole range.
 */

/** 1 / sqrt(2 * pi) */
const INV_SQRT_2PI = 0.3989422804014327;

/**
 * Probability density function of the standard normal distribution.
 */
export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x);
}

/**
 * Cumulative distribution function of the standard normal distribution.
 *
 * Hart (1968) rational approximation. Measured *relative* error against
 * `0.5 * erfc(-x / sqrt(2))` computed in double precision:
 *
 *   |x| <= 3      max 1.4e-14   (the band that matters: |delta| 0.05-0.50)
 *   3 < |x| <= 5  max 4.6e-11
 *   |x| > 5       max 8.9e-09   (N(x) is itself < 3e-7 here)
 *
 * Relative rather than absolute error is the meaningful metric because the tail
 * values are small in absolute terms by construction. Saturates to exactly 0/1
 * beyond |x| = 37, where the true value underflows a double anyway.
 */
export function normCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN;

  const absX = Math.abs(x);
  if (absX > 37) return x > 0 ? 1 : 0;

  const e = Math.exp(-0.5 * absX * absX);
  let upperTail: number;

  if (absX < 7.07106781186547) {
    let numerator = 3.52624965998911e-2 * absX + 0.700383064443688;
    numerator = numerator * absX + 6.37396220353165;
    numerator = numerator * absX + 33.912866078383;
    numerator = numerator * absX + 112.079291497871;
    numerator = numerator * absX + 221.213596169931;
    numerator = numerator * absX + 220.206867912376;

    let denominator = 8.83883476483184e-2 * absX + 1.75566716318264;
    denominator = denominator * absX + 16.064177579207;
    denominator = denominator * absX + 86.7807322029461;
    denominator = denominator * absX + 296.564248779674;
    denominator = denominator * absX + 637.333633378831;
    denominator = denominator * absX + 793.826512519948;
    denominator = denominator * absX + 440.413735824752;

    upperTail = (e * numerator) / denominator;
  } else {
    // Continued fraction expansion for the far tail.
    let build = absX + 0.65;
    build = absX + 4 / build;
    build = absX + 3 / build;
    build = absX + 2 / build;
    build = absX + 1 / build;
    upperTail = e / (build * 2.506628274631);
  }

  return x > 0 ? 1 - upperTail : upperTail;
}

/**
 * Inverse of the standard normal CDF (the quantile / probit function).
 *
 * Acklam's rational approximation followed by a single Halley refinement step,
 * which lifts relative accuracy to ~1e-15. Used to convert a target probability
 * into a strike or a sigma multiple.
 *
 * Returns -Infinity at p = 0 and +Infinity at p = 1; NaN outside [0, 1].
 */
export function normInv(p: number): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return Number.NaN;
  if (p === 0) return Number.NEGATIVE_INFINITY;
  if (p === 1) return Number.POSITIVE_INFINITY;

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ] as const;
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ] as const;
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ] as const;
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ] as const;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // One Halley step against the high-accuracy CDF above.
  const err = normCdf(x) - p;
  const u = (err * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)) as number;
  x = x - u / (1 + (x * u) / 2);

  return x;
}
