import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { AUCTION } from "@/config/car";
import { minimumBidFor, priceOf, topBidOf } from "@/lib/auction";
import {
  countSettledBidsForSpot,
  db,
  getBidderById,
  getPaidBidsForSpot,
  getTotalRaisedCents,
  listArtwork,
  listBidsForSpot,
  listSpots,
} from "@/lib/db";
import { isStripeConfigured } from "@/lib/stripe";
import type { Bidder } from "@/lib/types";

/**
 * Everything the operator needs on one screen: what each spot costs and who
 * holds it, the whole bid ledger, the bidders behind it, the review queue, and
 * the totals.
 *
 * Deliberately not here: Stripe customer ids and Checkout session ids. Neither
 * helps anyone reconcile a payment, and this response is read by a browser
 * holding a shared bearer token — the less of Stripe's namespace it carries,
 * the less a leaked console tab is worth. The payment intent and refund ids
 * stay, because looking a charge up in the dashboard is the whole job.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Defensive cap per spot. Eleven spots of honest bidding never approach it. */
const BID_PAGE = 500;

type Gate = { ok: true } | { ok: false; response: Response };

/**
 * The admin gate, repeated in each admin route because a route file may export
 * only route handlers — there is nowhere shared to put it that Next will accept.
 *
 * An unset ADMIN_TOKEN closes the console rather than opening it. Defaulting to
 * "no token configured means no check" is how an admin API ends up world-
 * writable the first time someone deploys without reading the env file.
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
  // Length is compared separately: timingSafeEqual throws on a mismatch, and a
  // thrown error leaks the same bit the comparison was meant to hide.
  const valid = a.length === b.length && timingSafeEqual(a, b);
  if (!valid) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Bad or missing x-admin-token." }, { status: 401 }),
    };
  }

  return { ok: true };
}

export async function GET(req: Request): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  const now = Date.now();
  const spots = listSpots();

  // One row per bidder however many bids they placed.
  const bidders = new Map<string, Bidder | null>();
  const bidderOf = (id: string): Bidder | null => {
    if (!bidders.has(id)) bidders.set(id, getBidderById(id));
    return bidders.get(id) ?? null;
  };

  const spotViews = spots.map((spot) => {
    const paid = getPaidBidsForSpot(spot.id);
    const top = topBidOf(paid);
    const holder = top ? bidderOf(top.bidderId) : null;

    return {
      id: spot.id,
      key: spot.key,
      name: spot.name,
      panel: spot.panel,
      status: spot.status,
      closesAt: spot.closesAt,
      extensionCount: spot.extensionCount,
      widthCm: spot.widthCm,
      heightCm: spot.heightCm,
      floorPriceCents: spot.floorPriceCents,
      currentPriceCents: priceOf(spot, paid),
      minimumNextBidCents: minimumBidFor(spot, paid),
      // Cumulative, matching the public board: bids that were ever real money,
      // including ones since outbid. paid.length would read "1 bid" on a spot
      // two people fought over.
      bidCount: countSettledBidsForSpot(spot.id),
      holder:
        top && holder
          ? {
              bidId: top.id,
              bidderId: holder.id,
              displayName: holder.displayName,
              email: holder.email,
              since: top.paidAt ?? top.createdAt,
              amountCents: top.amountCents,
            }
          : null,
    };
  });

  const spotById = new Map(spots.map((spot) => [spot.id, spot]));

  const bids = spots
    .flatMap((spot) => listBidsForSpot(spot.id, BID_PAGE))
    .map((bid) => {
      const spot = spotById.get(bid.spotId);
      const bidder = bidderOf(bid.bidderId);
      return {
        id: bid.id,
        spotId: bid.spotId,
        spotKey: spot?.key ?? null,
        spotName: spot?.name ?? null,
        bidderId: bid.bidderId,
        bidderName: bidder?.displayName ?? null,
        bidderEmail: bidder?.email ?? null,
        amountCents: bid.amountCents,
        status: bid.status,
        createdAt: bid.createdAt,
        paidAt: bid.paidAt,
        refundedAt: bid.refundedAt,
        sequence: bid.sequence,
        stripePaymentIntentId: bid.stripePaymentIntentId,
        stripeRefundId: bid.stripeRefundId,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  // The review queue first, then what has already been decided — the console
  // shows both, and a rejected file's reason is part of the audit trail.
  const artwork = listArtwork().map((item) => {
    const spot = spotById.get(item.spotId);
    const bidder = bidderOf(item.bidderId);
    return {
      id: item.id,
      bidId: item.bidId,
      spotId: item.spotId,
      spotKey: spot?.key ?? null,
      spotName: spot?.name ?? null,
      bidderId: item.bidderId,
      bidderName: bidder?.displayName ?? null,
      bidderEmail: bidder?.email ?? null,
      filename: item.filename,
      mimeType: item.mimeType,
      byteSize: item.byteSize,
      reviewStatus: item.reviewStatus,
      rejectionReason: item.rejectionReason,
      createdAt: item.createdAt,
      reviewedAt: item.reviewedAt,
    };
  });

  // Selected by column rather than mapped and pruned: a Stripe customer id
  // cannot leak out of a query that never asked for one.
  const people = db
    .prepare<unknown[], { id: string; email: string; display_name: string; created_at: number }>(
      `SELECT id, email, display_name, created_at FROM bidders ORDER BY created_at ASC`,
    )
    .all()
    .map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      createdAt: row.created_at,
      bidCount: bids.filter((bid) => bid.bidderId === row.id).length,
    }));

  const totalRaisedCents = getTotalRaisedCents();
  const owed = bids.filter((bid) => bid.status === "outbid" && bid.stripeRefundId === null);

  return NextResponse.json(
    {
      demo: !isStripeConfigured(),
      serverNow: now,
      spots: spotViews,
      bids,
      bidders: people,
      artwork,

      totalRaisedCents,
      goalCents: AUCTION.goalCents,
      goalPercent: Math.round((totalRaisedCents / AUCTION.goalCents) * 100),
      spotsTaken: spotViews.filter((spot) => spot.holder !== null).length,
      spotsTotal: spotViews.length,
      spotsClosed: spotViews.filter((spot) => spot.status === "closed").length,
      bidCount: bids.length,
      bidderCount: people.length,
      artworkPendingCount: artwork.filter((item) => item.reviewStatus === "pending").length,
      // Refunds the close job still has to make good; non-zero after a Stripe
      // failure, and the one number on this page that needs a human tonight.
      refundsOwedCount: owed.length,
      refundsOwedCents: owed.reduce((sum, bid) => sum + bid.amountCents, 0),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
