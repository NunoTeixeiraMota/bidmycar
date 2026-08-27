import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { priceOf } from "@/lib/auction";
import { getArtworkByBidId, getBidById, getPaidBidsForSpot, getSpotById } from "@/lib/db";
import { SESSION_COOKIE, verifyBidderCookie } from "@/lib/session";
import type { Artwork, Bid, SpotStatus } from "@/lib/types";

/**
 * One bid, for the page Stripe returns the buyer to.
 *
 * Two rules shape the response. Only the bidder who placed it, or an admin,
 * may read it, and a request that fails that check gets the same 404 as a bid
 * that does not exist, so the id space cannot be walked. And nothing Stripe
 * gave us goes out: a session or payment-intent id is a handle on somebody's
 * money, and this page has never needed one.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The bid as its owner may see it. */
type PublicBid = Omit<
  Bid,
  "stripeCheckoutSessionId" | "stripePaymentIntentId" | "stripeRefundId"
>;

/** Artwork without `storedPath`, which is ours and describes our filesystem. */
type PublicArtwork = Omit<Artwork, "storedPath">;

interface PublicSpot {
  key: string;
  name: string;
  panel: string;
  blurb: string;
  widthCm: number;
  heightCm: number;
  status: SpotStatus;
  closesAt: number;
  floorPriceCents: number;
  /** What it would cost to take the spot back, if this bid has been beaten. */
  currentPriceCents: number;
}

/**
 * Fields are copied out one at a time rather than spread-and-deleted, so a
 * column added to `Bid` later is absent from this payload until someone
 * decides it belongs here. The `PublicBid` annotation is what makes forgetting
 * an existing field a compile error rather than a missing value at runtime.
 */
function publicBid(bid: Bid): PublicBid {
  return {
    id: bid.id,
    spotId: bid.spotId,
    bidderId: bid.bidderId,
    amountCents: bid.amountCents,
    status: bid.status,
    createdAt: bid.createdAt,
    paidAt: bid.paidAt,
    refundedAt: bid.refundedAt,
    sequence: bid.sequence,
  };
}

function publicArtwork(artwork: Artwork): PublicArtwork {
  return {
    id: artwork.id,
    bidId: artwork.bidId,
    spotId: artwork.spotId,
    bidderId: artwork.bidderId,
    filename: artwork.filename,
    mimeType: artwork.mimeType,
    byteSize: artwork.byteSize,
    reviewStatus: artwork.reviewStatus,
    rejectionReason: artwork.rejectionReason,
    createdAt: artwork.createdAt,
    reviewedAt: artwork.reviewedAt,
  };
}

/** One body for "no such bid" and for "not yours": they must be identical. */
function notFound(): NextResponse {
  return NextResponse.json(
    { error: "No bid with that id." },
    { status: 404, headers: { "cache-control": "private, no-store" } },
  );
}

function isAdmin(request: NextRequest): boolean {
  const expected = process.env.ADMIN_TOKEN?.trim();
  // Never defaults open: with no token configured, nobody is an admin.
  if (!expected) return false;

  const presented = request.headers.get("x-admin-token");
  if (!presented) return false;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  // Length is compared separately because timingSafeEqual throws on a mismatch,
  // and a thrown error is itself a side channel.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ bidId: string }> },
): Promise<NextResponse> {
  const { bidId } = await params;

  const bid = getBidById(bidId);
  if (!bid) return notFound();

  const viewer = verifyBidderCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (viewer !== bid.bidderId && !isAdmin(request)) return notFound();

  const spot = getSpotById(bid.spotId);
  // A bid pointing at no spot is corruption, not a 404 the bidder caused.
  if (!spot) {
    return NextResponse.json(
      { error: "That bid's spot is missing." },
      { status: 500, headers: { "cache-control": "private, no-store" } },
    );
  }

  const artwork = getArtworkByBidId(bid.id);

  return NextResponse.json(
    {
      bid: publicBid(bid),
      spot: {
        key: spot.key,
        name: spot.name,
        panel: spot.panel,
        blurb: spot.blurb,
        widthCm: spot.widthCm,
        heightCm: spot.heightCm,
        status: spot.status,
        closesAt: spot.closesAt,
        floorPriceCents: spot.floorPriceCents,
        currentPriceCents: priceOf(spot, getPaidBidsForSpot(spot.id)),
      } satisfies PublicSpot,
      artwork: artwork ? publicArtwork(artwork) : null,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
