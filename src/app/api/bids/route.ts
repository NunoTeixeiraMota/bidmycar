import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { expireBid, markRefunded, settleBid, startBid } from "@/lib/auction";
import {
  getBidById,
  getBidderByEmail,
  getBidderById,
  insertBidder,
  updateBid,
  updateBidder,
} from "@/lib/db";
import { SESSION_COOKIE, cookieOptions, signBidderId, verifyBidderCookie } from "@/lib/session";
import { createCheckoutSession, refundPayment } from "@/lib/stripe";
import type { Bidder, StartBidResult } from "@/lib/types";

/**
 * Placing a bid.
 *
 * The order matters: validate, resolve who is bidding, let the engine accept or
 * refuse the amount, and only then open a checkout. A rejected bid must never
 * reach Stripe, and a bid that reaches Stripe must already exist in our
 * database — the webhook has nothing to settle otherwise.
 *
 * Nothing here decides whether money arrived. The bid row created below is
 * inert until `settleBid` runs, from the webhook in production or from this
 * route in demo mode.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BidRequest = z.object({
  spotKey: z.string().trim().min(1).max(64),
  amountCents: z.number().int().positive(),
  // 254 is the longest address SMTP will carry; `z.email()` covers the shape.
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(60),
});

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

function json(body: StartBidResult, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * The same answer, carrying the bidder's session.
 *
 * Set on every bid rather than only on the first, so the thirty-day window
 * slides forward while someone is still actively bidding — losing the cookie
 * mid-auction would strand them from the spots they are holding.
 */
function jsonAs(bidder: Bidder, body: StartBidResult, status = 200): NextResponse {
  const response = json(body, status);
  response.cookies.set(SESSION_COOKIE, signBidderId(bidder.id), cookieOptions());
  return response;
}

/**
 * A malformed body is answered in the same shape as a refused bid, so the
 * dialog has one code path, but with a 4xx: this is a broken request, not a
 * decision the auction made.
 */
function invalid(issues: z.ZodError["issues"]): NextResponse {
  const field = issues[0]?.path[0];
  if (field === "amountCents") {
    return json(
      {
        ok: false,
        reason: "amount_invalid",
        message: "A bid must be a whole number of cents above zero.",
      },
      400,
    );
  }
  if (field === "spotKey") {
    return json({ ok: false, reason: "spot_unknown", message: "That spot is not on this car." }, 400);
  }
  return json(
    {
      ok: false,
      reason: "bidder_unknown",
      message: "We need an email address and a name to show beside the spot.",
    },
    400,
  );
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * The bidder this request belongs to, created if they are new.
 *
 * The signed cookie outranks the typed email: a cookie is proof, an address in
 * a form is a claim. Reading it the other way round would let anyone point an
 * existing session at somebody else's identity just by typing their address.
 */
function resolveBidder(request: NextRequest, email: string, displayName: string): Bidder {
  const claimed = verifyBidderCookie(request.cookies.get(SESSION_COOKIE)?.value);
  const existing = (claimed ? getBidderById(claimed) : null) ?? getBidderByEmail(email);

  if (existing) {
    // The name beside the spot should be the one they just typed. The email is
    // deliberately left alone — it is the unique key this row was found by.
    if (existing.displayName === displayName) return existing;
    return updateBidder(existing.id, { displayName }) ?? existing;
  }

  try {
    return insertBidder({ email, displayName });
  } catch {
    // Two first bids from the same address in flight at once: one insert wins,
    // the other hits the UNIQUE index. A returning bidder resumes their
    // identity, so losing that race is not an error the bidder should ever see.
    const raced = getBidderByEmail(email);
    if (raced) return raced;
    throw new Error(`Could not create or find a bidder for ${email}.`);
  }
}

/* ------------------------------------------------------------------ *
 * Demo settlement
 * ------------------------------------------------------------------ */

/** Give a beaten bidder their money back. Safe to call twice. */
async function refundBeaten(bidId: string): Promise<void> {
  const beaten = getBidById(bidId);
  // Anything but `outbid` means somebody already handled this one.
  if (!beaten || beaten.status !== "outbid") return;

  const refund = await refundPayment(beaten.stripePaymentIntentId);
  if (refund.ok) {
    markRefunded(beaten.id, refund.refundId, Date.now());
    return;
  }
  // Left `outbid` on purpose: closeAuction() reports every outbid bid with no
  // refund id against it, so the next sweep picks this up and tries again.
  console.error(`[bids] refund failed for ${bidId}: ${refund.message}`);
}

/**
 * With no Stripe keys the bid settles here and now, without money.
 *
 * This is what makes a fresh clone playable: seed, run, bid, win. It follows
 * exactly the same path a webhook would — settle, then refund whoever the
 * settlement displaced — so demo mode exercises the real state machine rather
 * than a simplified one.
 */
async function settleDemoBid(bidId: string, now: number): Promise<StartBidResult> {
  const settlement = settleBid({ bidId, paymentIntentId: null, now });

  // `becameHolder: false` means THIS bid is the one owed its money back; a
  // displaced id means the bid it beat is. Never both.
  const owed = settlement.becameHolder ? settlement.displacedBidId : settlement.bidId;
  if (owed) await refundBeaten(owed);

  return { ok: true, bidId, checkoutUrl: null, demo: true };
}

/* ------------------------------------------------------------------ *
 * Origin
 * ------------------------------------------------------------------ */

/**
 * Where Stripe should send the buyer back to.
 *
 * A literal localhost here is how a deployed checkout returns real buyers to a
 * laptop that is not running, so the configured site URL wins and the request's
 * own origin is only a development convenience.
 */
function siteOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const header = request.headers.get("origin");
  if (header) {
    try {
      const url = new URL(header);
      if (url.protocol === "http:" || url.protocol === "https:") return url.origin;
    } catch {
      // A header this malformed is not worth handing to Stripe.
    }
  }
  return request.nextUrl.origin;
}

/* ------------------------------------------------------------------ *
 * The route
 * ------------------------------------------------------------------ */

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { ok: false, reason: "amount_invalid", message: "That bid could not be read." },
      400,
    );
  }

  const parsed = BidRequest.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues);
  const { spotKey, amountCents, email, displayName } = parsed.data;

  const bidder = resolveBidder(request, email, displayName);

  const now = Date.now();
  const outcome = startBid({ spotKey, bidderId: bidder.id, amountCents, now });
  // A refusal is the auction working, not the request failing: 200, with the
  // reason and a message the dialog can show verbatim.
  if (!outcome.ok) return jsonAs(bidder, outcome);

  const { bid, spot } = outcome;
  const origin = siteOrigin(request);

  // Branch on what the call reports rather than sniffing the environment for
  // keys: stripe.ts owns that decision, and reading it twice invites the two
  // answers to disagree.
  const checkout = await createCheckoutSession({
    bidId: bid.id,
    spotKey: spot.key,
    spotName: spot.name,
    amountCents: bid.amountCents,
    customerEmail: bidder.email,
    successUrl: `${origin}/bid/${bid.id}`,
    cancelUrl: `${origin}/#spots`,
  });

  if (!checkout.ok) {
    // The row exists but no checkout ever opened, and nothing will ever settle
    // it. Expiring it now is what stops the bid page telling this bidder we are
    // "confirming payment" for a payment that was never started.
    expireBid(bid.id, Date.now());
    return jsonAs(bidder, {
      ok: false,
      reason: "stripe_unavailable",
      message: "Payments are unavailable right now, so this bid could not be taken.",
    });
  }

  if (checkout.demo) return jsonAs(bidder, await settleDemoBid(bid.id, Date.now()));

  // Stored before the URL leaves this function: the webhook resolves a delivery
  // back to a bid through this id, and it can land while the buyer's browser is
  // still following the redirect.
  updateBid(bid.id, { stripeCheckoutSessionId: checkout.sessionId });

  return jsonAs(bidder, { ok: true, bidId: bid.id, checkoutUrl: checkout.url, demo: false });
}
