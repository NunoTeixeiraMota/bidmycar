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
 * The smallest bid the auction takes.
 *
 * There is no increment ladder and no minimum next bid: any amount from this
 * upward is accepted and charged. Whether it takes the panel is decided in
 * auction.ts, by comparing it against the spot's listed price and against the
 * other bids, not by a rule about how much more it has to be than the last one.
 *
 * It sits above Stripe's own processing minimum of roughly fifty cents, so a
 * bid that passes here is one Stripe will actually charge.
 *
 * It lives in this module rather than in auction.ts because the bid dialog
 * needs it in the browser, and auction.ts reaches the database: importing that
 * from a client component drags better-sqlite3 into the client bundle.
 */
export const MIN_BID_CENTS = 100;

/**
 * How much more than the standing price it takes to win a panel.
 *
 * A flat euro, not a percentage: at these amounts a percentage step is either
 * invisible or absurd, and "one euro more than the last one" is a rule anybody
 * can hold in their head while typing.
 *
 * It gates taking the spot, not bidding. Less than this is still accepted and
 * still charged; it just joins the roll instead of the car.
 */
export const BID_STEP_CENTS = 100;
