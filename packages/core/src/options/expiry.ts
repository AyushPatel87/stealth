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
 * Whole days until expiry, for display. Rounds UP so that a contract expiring
 * later today reads as "1 DTE" rather than "0 DTE" while it is still tradeable,
 * and returns 0 only once it has actually expired.
 */
export function calendarDte(now: Date, expiration: Date): number {
  const exact = daysToExpiry(now, expiration);
  return exact <= 0 ? 0 : Math.ceil(exact);
}

/**
 * Time to expiry in years, for pricing. Clamped at 0 for expired contracts so
 * it can be handed straight to the pricer.
 */
export function yearsToExpiry(now: Date, expiration: Date): number {
  return Math.max(daysToExpiry(now, expiration), 0) / DAYS_PER_YEAR;
}
