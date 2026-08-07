import { describe, expect, it } from 'vitest';
import {
  calendarDte,
  daysToExpiry,
  expirationInstant,
  yearsToExpiry,
} from './expiry.js';

describe('expirationInstant', () => {
  it('resolves to 16:00 New York during Eastern Standard Time (UTC-5)', () => {
    // 2026-01-16 is a January monthly expiration; EST is UTC-5, so 16:00 ET is
    // 21:00 UTC.
    expect(expirationInstant('2026-01-16').toISOString()).toBe(
      '2026-01-16T21:00:00.000Z',
    );
  });

  it('resolves to 16:00 New York during Eastern Daylight Time (UTC-4)', () => {
    // 2026-08-21 is in EDT (UTC-4), so 16:00 ET is 20:00 UTC. Getting this
    // wrong would shift every summer expiration by an hour.
    expect(expirationInstant('2026-08-21').toISOString()).toBe(
      '2026-08-21T20:00:00.000Z',
    );
  });

  it('handles the days either side of a DST transition', () => {
    // US DST began 2026-03-08. The Friday before is EST, the Friday after EDT.
    expect(expirationInstant('2026-03-06').toISOString()).toBe(
      '2026-03-06T21:00:00.000Z',
    );
    expect(expirationInstant('2026-03-13').toISOString()).toBe(
      '2026-03-13T20:00:00.000Z',
    );
  });

  it('rejects malformed dates rather than silently producing an Invalid Date', () => {
    expect(() => expirationInstant('2026-8-21')).toThrow(RangeError);
    expect(() => expirationInstant('21/08/2026')).toThrow(RangeError);
    expect(() => expirationInstant('')).toThrow(RangeError);
    expect(() => expirationInstant('2026-13-01')).toThrow(RangeError);
    expect(() => expirationInstant('2026-08-32')).toThrow(RangeError);
  });
});

describe('daysToExpiry / calendarDte / yearsToExpiry', () => {
  const expiration = expirationInstant('2026-08-21');

  it('computes fractional days', () => {
    const now = new Date('2026-08-07T20:00:00.000Z');
    expect(daysToExpiry(now, expiration)).toBeCloseTo(14, 10);
  });

  it('reports whole days for display, rounding up while still tradeable', () => {
    // Mid-session on expiration day: still 0.25 days of life left.
    const duringExpiryDay = new Date('2026-08-21T14:00:00.000Z');
    expect(calendarDte(duringExpiryDay, expiration)).toBe(1);

    // Two and a bit days out reads as 3, not 2.
    const twoAndABit = new Date('2026-08-19T02:00:00.000Z');
    expect(daysToExpiry(twoAndABit, expiration)).toBeGreaterThan(2);
    expect(calendarDte(twoAndABit, expiration)).toBe(3);
  });

  it('reports 0 DTE only once actually expired', () => {
    const afterClose = new Date('2026-08-21T20:00:00.001Z');
    expect(calendarDte(afterClose, expiration)).toBe(0);
    expect(yearsToExpiry(afterClose, expiration)).toBe(0);
  });

  it('clamps negative time to zero for pricing but not for display maths', () => {
    const wellAfter = new Date('2026-09-01T00:00:00.000Z');
    expect(daysToExpiry(wellAfter, expiration)).toBeLessThan(0);
    expect(yearsToExpiry(wellAfter, expiration)).toBe(0);
    expect(calendarDte(wellAfter, expiration)).toBe(0);
  });

  it('converts to years on a 365-day basis', () => {
    const now = new Date('2026-08-07T20:00:00.000Z');
    expect(yearsToExpiry(now, expiration)).toBeCloseTo(14 / 365, 12);
  });

  it('measures real elapsed time across a DST boundary, not wall-clock days', () => {
    // The 2026-03-08 spring-forward sits inside this window. Two consecutive
    // "Friday 16:00 ET" expirations 14 calendar days apart are separated by
    // 335 hours, not 336, because one of those days was only 23 hours long.
    //
    // Reporting 14.0 here would be wrong: theta decays in real time, so the
    // pricing term must reflect the hour that never existed. This is precisely
    // why expirations are resolved to UTC instants rather than local dates.
    const start = expirationInstant('2026-03-06');
    const end = expirationInstant('2026-03-20');

    expect(daysToExpiry(start, end)).toBeCloseTo(14 - 1 / 24, 10);
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(335);

    // Display still rounds to the intuitive whole number.
    expect(calendarDte(start, end)).toBe(14);
  });

  it('measures the extra hour across the autumn fall-back', () => {
    // 2026-11-01 falls back, making one day 25 hours long.
    const start = expirationInstant('2026-10-30');
    const end = expirationInstant('2026-11-13');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(337);
    expect(calendarDte(start, end)).toBe(15);
  });
});
