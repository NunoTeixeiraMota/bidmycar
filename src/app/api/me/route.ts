import { NextResponse, type NextRequest } from "next/server";

import { getBidderById, getTopPaidBid, listSpots } from "@/lib/db";
import { SESSION_COOKIE, clearedCookieOptions, verifyBidderCookie } from "@/lib/session";

/**
 * Who the browser is, and what it currently holds.
 *
 * Convenience only: it prefills the bid form and puts a "you hold this" badge
 * on a card. Nothing here is authorisation, so an unrecognised visitor is a
 * 200 with nulls rather than a 401 — the board must render for strangers.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest): Response {
  const claimed = verifyBidderCookie(request.cookies.get(SESSION_COOKIE)?.value);
  const bidder = claimed ? getBidderById(claimed) : null;

  // Only the spots this bidder is top of. A settled bid that has been beaten is
  // still theirs, but it holds nothing, which is the distinction the badge draws.
  const heldSpots = bidder
    ? listSpots()
        .filter((spot) => getTopPaidBid(spot.id)?.bidderId === bidder.id)
        .map((spot) => spot.key)
    : [];

  const response = NextResponse.json(
    {
      // stripeCustomerId stays server-side: it is a handle on a payment method,
      // and nothing in the browser has any use for it.
      bidder: bidder
        ? { id: bidder.id, displayName: bidder.displayName, email: bidder.email }
        : null,
      heldSpots,
    },
    { headers: { "cache-control": "private, no-store" } },
  );

  // A cookie whose signature is good but whose bidder is gone can never start
  // working again. Clearing it makes the next bid mint a fresh identity instead
  // of resolving to nobody forever.
  if (claimed && !bidder) {
    response.cookies.set(SESSION_COOKIE, "", clearedCookieOptions());
  }

  return response;
}
