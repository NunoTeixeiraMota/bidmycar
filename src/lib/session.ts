import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";

/**
 * Bidder identity.
 *
 * There is no password and no account. A bidder is an email plus a display
 * name, and the browser proves which bidder it is by presenting an httpOnly
 * cookie holding their id and an HMAC of that id.
 *
 * The cookie is a bearer credential over money — whoever holds it can spend on
 * a card the site has already charged and can claim the spots that identity
 * holds. So the signature is the whole security story here, which is why an
 * unset secret is a hard failure in production rather than a default.
 */

export const SESSION_COOKIE = "spot_bidder";

/** Thirty days: long enough to still hold your spot at the end of a 12-day auction. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/* ------------------------------------------------------------------ *
 * The secret
 * ------------------------------------------------------------------ */

let warnedAboutDerivedSecret = false;

/**
 * A derived development secret, so `npm run dev` works out of the box.
 *
 * Stable across restarts (nothing random in it) but different on every
 * machine and checkout, so a cookie forged against one developer's tree is
 * worthless against another's. It is NOT a fallback for production: it is
 * derivable by anyone who can guess a hostname and a path, which is precisely
 * the property that makes it unacceptable once real cards are involved.
 */
function derivedDevSecret(): string {
  return createHash("sha256")
    .update(`datsun-100a-auction:dev:${hostname()}:${process.cwd()}`)
    .digest("hex");
}

function sessionSecret(): string {
  const configured = process.env.SESSION_SECRET?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    // Failing closed. With a known secret anyone can mint a cookie for any
    // bidder id and take over a spot somebody paid for.
    throw new Error(
      "SESSION_SECRET is not set. Generate one with `openssl rand -hex 32` and " +
        "put it in the environment before starting the server in production.",
    );
  }

  if (!warnedAboutDerivedSecret) {
    warnedAboutDerivedSecret = true;
    console.warn(
      "[session] SESSION_SECRET is not set — using a secret derived from this " +
        "machine and directory. Fine for development; set a real one before deploying.",
    );
  }
  return derivedDevSecret();
}

/* ------------------------------------------------------------------ *
 * Signing
 * ------------------------------------------------------------------ */

function mac(bidderId: string): string {
  return createHmac("sha256", sessionSecret()).update(bidderId).digest("base64url");
}

/** Cookie value for a bidder: `<bidderId>.<base64url HMAC-SHA256>`. */
export function signBidderId(bidderId: string): string {
  return `${bidderId}.${mac(bidderId)}`;
}

/**
 * The bidder id a cookie proves, or null if it proves nothing.
 *
 * Every failure path returns null rather than throwing: a stale cookie from an
 * older secret is an ordinary event (the visitor is simply signed out), not an
 * error worth a 500. The one exception is a missing secret in production,
 * which `sessionSecret` throws for and which must not be swallowed here.
 */
export function verifyBidderCookie(value: string | undefined): string | null {
  if (!value) return null;

  // Last dot, not first: ids are `<prefix>_<base62>` today, but splitting from
  // the right keeps this correct if an id ever contains a dot.
  const cut = value.lastIndexOf(".");
  if (cut <= 0 || cut === value.length - 1) return null;

  const bidderId = value.slice(0, cut);
  const presented = value.slice(cut + 1);

  // Compare the base64url text, not decoded bytes: two different strings can
  // decode to the same buffer, and a decode would also have to be guarded.
  const expected = Buffer.from(mac(bidderId), "utf8");
  const given = Buffer.from(presented, "utf8");

  // timingSafeEqual throws on a length mismatch, and a thrown error is itself
  // a side channel, so length is checked first and separately.
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  return bidderId;
}

/* ------------------------------------------------------------------ *
 * Cookie attributes
 * ------------------------------------------------------------------ */

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

/**
 * `lax` rather than `strict`: Stripe Checkout sends the buyer back to us as a
 * top-level cross-site navigation, and under `strict` the cookie would not be
 * sent on that request — the bidder would land on their own receipt page
 * signed out.
 */
export function cookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/** Same attributes, zero lifetime — what you set to sign a bidder out. */
export function clearedCookieOptions(): SessionCookieOptions {
  return { ...cookieOptions(), maxAge: 0 };
}
