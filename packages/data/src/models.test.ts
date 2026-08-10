import { describe, expect, it } from 'vitest';
import {
  ageMs,
  earningsBeforeExpiration,
  effectiveAgeMs,
  type EarningsEvent,
  type Provenance,
} from './models.js';

function provenance(
  fetchedAt: string,
  delayedByMinutes: number | null = null,
): Provenance {
  return { source: 'test', fetchedAt: new Date(fetchedAt), delayedByMinutes };
}

describe('ageMs and effectiveAgeMs', () => {
  const now = new Date('2026-08-07T15:00:00.000Z');

  it('measures elapsed time since fetch', () => {
    expect(ageMs(provenance('2026-08-07T14:58:00.000Z'), now)).toBe(120_000);
  });

  it('adds the providers own exchange delay', () => {
    // Fetched 2 minutes ago from a 15-minute-delayed feed reflects the market
    // as of 17 minutes ago. Displaying "2 minutes ago" would overstate
    // freshness by an order of magnitude.
    const p = provenance('2026-08-07T14:58:00.000Z', 15);
    expect(ageMs(p, now)).toBe(120_000);
    expect(effectiveAgeMs(p, now)).toBe(120_000 + 15 * 60_000);
  });

  it('treats an unreported delay as zero rather than guessing 15 minutes', () => {
    const p = provenance('2026-08-07T14:58:00.000Z', null);
    expect(effectiveAgeMs(p, now)).toBe(120_000);
  });

  it('handles a real-time feed', () => {
    const p = provenance('2026-08-07T14:58:00.000Z', 0);
    expect(effectiveAgeMs(p, now)).toBe(120_000);
  });
});

describe('earningsBeforeExpiration', () => {
  const expiration = new Date('2026-08-21T20:00:00.000Z');

  function earnings(
    date: string,
    timing: EarningsEvent['timing'] = 'unknown',
    isEstimate = false,
  ): EarningsEvent {
    return {
      symbol: 'TEST',
      date: new Date(date),
      isEstimate,
      timing,
      provenance: provenance('2026-08-07T15:00:00.000Z'),
    };
  }

  it('detects earnings falling inside the contract life', () => {
    expect(
      earningsBeforeExpiration(earnings('2026-08-14T20:00:00.000Z'), expiration),
    ).toBe(true);
  });

  it('ignores earnings after expiration', () => {
    expect(
      earningsBeforeExpiration(earnings('2026-08-28T20:00:00.000Z'), expiration),
    ).toBe(false);
  });

  it('excludes an after-close report on expiration day', () => {
    // The option has already settled at 16:00 ET, so an after-close report
    // cannot affect the position. Excluding this trade would discard a safe one.
    expect(
      earningsBeforeExpiration(
        earnings('2026-08-21T20:00:00.000Z', 'after-close'),
        expiration,
      ),
    ).toBe(false);
  });

  it('includes a before-open report on expiration day', () => {
    // This one gaps the underlying while the position is still open.
    expect(
      earningsBeforeExpiration(
        earnings('2026-08-21T20:00:00.000Z', 'before-open'),
        expiration,
      ),
    ).toBe(true);
  });

  it('treats unknown timing on expiration day as safe', () => {
    // Matches the after-close default that most providers imply when they
    // report only a date.
    expect(
      earningsBeforeExpiration(
        earnings('2026-08-21T20:00:00.000Z', 'unknown'),
        expiration,
      ),
    ).toBe(false);
  });

  it('carries the estimate flag through for UI display', () => {
    const estimated = earnings('2026-08-14T20:00:00.000Z', 'unknown', true);
    expect(estimated.isEstimate).toBe(true);
    expect(earningsBeforeExpiration(estimated, expiration)).toBe(true);
  });
});
