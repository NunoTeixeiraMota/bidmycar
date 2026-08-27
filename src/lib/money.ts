import type { Currency } from "./types";

/**
 * Money helpers. Everything here takes and returns integer cents.
 * `formatMoney` is the ONLY place cents become a human-readable string.
 */

export const CURRENCY: Currency = "EUR";

export function formatMoney(cents: number, opts: { compact?: boolean } = {}): string {
  const value = cents / 100;
  return new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: CURRENCY,
    // Whole euros read better on an auction board; cents only when non-zero.
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    notation: opts.compact ? "compact" : "standard",
  }).format(value);
}

/** Parse user input ("12 500", "€12,500.50", "12500") into integer cents. */
export function parseMoneyToCents(input: string): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, "").trim();
  if (!cleaned) return null;

  // Treat the LAST separator as the decimal point only when it leaves 1-2
  // trailing digits; otherwise it is a thousands separator ("12,500").
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);

  let normalised: string;
  if (lastSep === -1) {
    normalised = cleaned;
  } else {
    const tail = cleaned.slice(lastSep + 1);
    if (/^\d{1,2}$/.test(tail)) {
      normalised = cleaned.slice(0, lastSep).replace(/[.,]/g, "") + "." + tail;
    } else {
      normalised = cleaned.replace(/[.,]/g, "");
    }
  }

  const value = Number(normalised);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * Bid increment. Spots open between €90 and €155, so a fixed ladder tuned for
 * a five-figure car would be nonsense here: the step is a percentage of the
 * standing price with a hard floor, which keeps early bidding meaningful and
 * stops a €400 spot being nudged up in €5 increments.
 */
export const MIN_INCREMENT_CENTS = 1000; // €10
export const INCREMENT_PERCENT = 0.05;   // 5%

export function incrementFor(currentCents: number): number {
  const pct = Math.ceil((currentCents * INCREMENT_PERCENT) / 100) * 100; // whole euros
  return Math.max(MIN_INCREMENT_CENTS, pct);
}

/** The smallest bid that beats `currentCents`. */
export function minimumNextBid(currentCents: number): number {
  return currentCents + incrementFor(currentCents);
}
