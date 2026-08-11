/**
 * Expiration timing.
 *
 * DTE feeds directly into annualised yield (which scales by 365/DTE) and into
 * the Black-Scholes time term, so an off-by-one here distorts both the ranking
 * and the Greeks. Two conventions are kept deliberately separate:
 *
 *   - `calendarDte`  whole days, for display ("14 DTE"). Matches broker UIs.
 *   - `yearsToExpiry` continuous, for pricing. A contract expiring in 6 hours
 *                     is not the same as one expiring in 1 day, and rounding it
 *                     to 1 would misprice it badly.
 *
 * Every function takes `now` explicitly. Nothing in this package reads the
 * system clock, so tests are deterministic.
 */

const MS_PER_DAY = 86_400_000;
export const DAYS_PER_YEAR = 365;

/** US equity options stop trading at 16:00 America/New_York on expiry day. */
const MARKET_CLOSE_HOUR = 16;
const US_MARKET_TIMEZONE = 'America/New_York';

/**
 * Resolves the UTC instant corresponding to a wall-clock time in a named IANA
 * timezone, correctly handling DST. Uses `Intl` rather than a date library so
 * `@stealth/core` stays dependency-free.
 */
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  // First guess: treat the wall-clock time as if it were UTC.
  const guess = Date.UTC(year, month - 1, day, hour, minute);

  // Ask what that instant actually reads as in the target zone, then correct by
  // the difference. One correction pass suffices for all real UTC offsets.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = formatter.formatToParts(new Date(guess));
  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = Number(part.value);
    }
  }

  const asUtcOfZoned = Date.UTC(
    lookup.year ?? year,
    (lookup.month ?? month) - 1,
    lookup.day ?? day,
    // Intl renders midnight as hour 24 in some environments.
    (lookup.hour ?? hour) % 24,
    lookup.minute ?? minute,
    lookup.second ?? 0,
  );

  return new Date(guess - (asUtcOfZoned - guess));
}

/**
 * The instant a US equity option expires: 16:00 America/New_York on the
 * expiration date. Accepts a `YYYY-MM-DD` string, which is how every provider
 * we integrate reports expirations.
 *
 * @throws RangeError on a malformed date string.
 */
export function expirationInstant(isoDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) {
    throw new RangeError(
      `expiration must be formatted YYYY-MM-DD, got ${JSON.stringify(isoDate)}`,
    );
  }
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`expiration is not a valid date: ${isoDate}`);
  }

  return zonedWallClockToUtc(
    year,
    month,
    day,
    MARKET_CLOSE_HOUR,
    0,
    US_MARKET_TIMEZONE,
  );
}

/**
 * Fractional days until expiry. Negative once expired.
 */
export function daysToExpiry(now: Date, expiration: Date): number {
  return (expiration.getTime() - now.getTime()) / MS_PER_DAY;
}

/**
 * Whole days until expiry, for display.
 *
 * Counts the difference between CALENDAR DATES in market time, not elapsed
 * hours. This matters twice over:
 *
 *  - A contract expiring today is 0 DTE. "0DTE" is the industry term for
 *    same-day expiry, so any other answer reads as wrong to a trader.
 *  - Aug 7 to Aug 21 is 14 DTE regardless of the time of day. Rounding elapsed
 *    hours up would report 15 for most of the trading session, putting every
 *    contract one day off the figure a broker shows.
 *
 * Since annualised yield scales by 365/DTE, a systematic off-by-one here would
 * misstate every yield in the scanner by roughly 7% at two weeks out.
 */
export function calendarDte(now: Date, expiration: Date): number {
  const days =
    (marketDateAsUtcMidnight(expiration) - marketDateAsUtcMidnight(now)) /
    MS_PER_DAY;
  return Math.max(0, Math.round(days));
}

/**
 * The calendar date in New York, expressed as a UTC midnight, so two dates can
 * be subtracted without timezone or DST interference.
 */
function marketDateAsUtcMidnight(instant: Date): number {
  // 'en-CA' renders as YYYY-MM-DD.
  const isoDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: US_MARKET_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return Date.parse(`${isoDate}T00:00:00Z`);
}

/**
 * Time to expiry in years, for pricing. Clamped at 0 for expired contracts so
 * it can be handed straight to the pricer.
 */
export function yearsToExpiry(now: Date, expiration: Date): number {
  return Math.max(daysToExpiry(now, expiration), 0) / DAYS_PER_YEAR;
}
