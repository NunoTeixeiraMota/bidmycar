import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { AuctionError, closeAuction, markRefunded } from "@/lib/auction";
import { getBidById, getBidderById, getSpotByKey } from "@/lib/db";
import { isStripeConfigured, refundPayment } from "@/lib/stripe";

/**
 * Stop the clock and pay everybody back.
 *
 * Two steps that must not be one. `closeAuction` decides the winners in a
 * single transaction and hands back the bids owed money; the refunds then go
 * out one at a time over the network. A Stripe failure on one card must not
 * roll back a close that already happened, or abandon the nine refunds behind
 * it — so each is attempted independently and reported by bid.
 *
 * Re-running this is the retry. The second call closes nothing (every spot is
 * already shut) but still lists every outbid bid whose refund has not landed,
 * so a failure tonight is simply pressed again in the morning.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Gate = { ok: true } | { ok: false; response: Response };

/**
 * The admin gate, repeated in each admin route because a route file may export
 * only route handlers — there is nowhere shared to put it that Next will accept.
 *
 * An unset ADMIN_TOKEN closes the console rather than opening it. This route
 * ends the auction and moves real money; it never runs on a default.
 */
function requireAdmin(req: Request): Gate {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error:
            "ADMIN_TOKEN is not set on the server, so the admin API is closed. " +
            "Generate one with `openssl rand -hex 32`, set it in the environment, and restart.",
        },
        { status: 503 },
      ),
    };
  }

  const presented = req.headers.get("x-admin-token")?.trim();
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented ?? "", "utf8");
  // Length separately: timingSafeEqual throws on a mismatch, and the throw leaks
  // the same bit the comparison hides.
  const valid = a.length === b.length && timingSafeEqual(a, b);
  if (!valid) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Bad or missing x-admin-token." }, { status: 401 }),
    };
  }

  return { ok: true };
}

/** One line per bid owed money, so a partial failure is visible and retryable. */
interface RefundReport {
  bidId: string;
  ok: boolean;
  amountCents?: number;
  refundId?: string;
  /** True when the charge was already refunded and this is the existing refund. */
  alreadyRefunded?: boolean;
  /** True when no money moved: demo mode, or a bid that never had a charge. */
  demo?: boolean;
  error?: string;
  /** Whether pressing close again is likely to fix it. */
  retryable?: boolean;
}

export async function POST(req: Request): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  const now = Date.now();
  const result = closeAuction(now);

  const refunds: RefundReport[] = [];
  for (const bidId of result.refundedBidIds) {
    const bid = getBidById(bidId);
    if (!bid) {
      refunds.push({ bidId, ok: false, error: "That bid no longer exists.", retryable: false });
      continue;
    }

    try {
      const outcome = await refundPayment(bid.stripePaymentIntentId);
      if (!outcome.ok) {
        refunds.push({
          bidId,
          ok: false,
          amountCents: bid.amountCents,
          error: outcome.message,
          retryable: outcome.retryable,
        });
        continue;
      }

      markRefunded(bid.id, outcome.refundId, now);
      refunds.push({
        bidId,
        ok: true,
        amountCents: bid.amountCents,
        refundId: outcome.refundId,
        alreadyRefunded: outcome.alreadyRefunded,
        demo: outcome.demo,
      });
    } catch (err) {
      // Caught per bid, not per batch: the money may well be back and only the
      // bookkeeping failed, and the nine bidders behind this one are still owed.
      const message =
        err instanceof AuctionError || err instanceof Error
          ? err.message
          : "The refund could not be recorded.";
      console.error(`[close] refunding bid ${bidId} failed:`, err);
      refunds.push({ bidId, ok: false, amountCents: bid.amountCents, error: message, retryable: true });
    }
  }

  const winners = result.winners.map((winner) => {
    const bidder = getBidderById(winner.bidderId);
    const spot = getSpotByKey(winner.spotKey);
    return {
      ...winner,
      spotName: spot?.name ?? null,
      displayName: bidder?.displayName ?? null,
      // The operator emails these people about artwork and delivery.
      email: bidder?.email ?? null,
    };
  });

  const failed = refunds.filter((refund) => !refund.ok);

  return NextResponse.json(
    {
      closedSpots: result.closedSpots,
      winners,
      refundedBidIds: result.refundedBidIds,
      refunds,
      refundedCount: refunds.length - failed.length,
      failedCount: failed.length,
      refundedCents: refunds
        .filter((refund) => refund.ok)
        .reduce((sum, refund) => sum + (refund.amountCents ?? 0), 0),
      demo: !isStripeConfigured(),
      serverNow: now,
    },
    // 200 even with failures: the close itself succeeded and the body is the
    // report. A non-2xx here would tell the console the auction is still open.
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
