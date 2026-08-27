import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { AUCTION } from "@/config/car";
import { getBidById } from "@/lib/db";
import { SESSION_COOKIE, verifyBidderCookie } from "@/lib/session";
import { UploadValidationError, storeArtwork, validateUpload } from "@/lib/uploads";
import type { BidStatus } from "@/lib/types";

/**
 * Logo upload.
 *
 * Two gates, in this order: the cookie must prove the uploader is the bidder
 * whose bid this is, and that bid must actually hold its spot. Artwork attached
 * to a bid that never paid, or that has since been outbid, would sit in the
 * review queue as work for a human and — once approved — as a logo the board is
 * ready to composite for someone who is owed a refund instead.
 *
 * The bytes themselves are not judged here. `validateUpload` sniffs them, and
 * its rejection message is written for the uploader, so it is returned verbatim
 * rather than translated into something vaguer.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MB = Math.round(AUCTION.maxLogoBytes / (1024 * 1024));

/** Why this bid cannot receive artwork, in the words the uploader needs. */
function blockedBecause(status: BidStatus): string {
  switch (status) {
    case "pending_payment":
      return "That bid hasn't been paid yet. Finish checkout and the upload will open up.";
    case "outbid":
    case "refunded":
      return "You've been outbid on that spot, so there's nothing to print. Your payment is on its way back.";
    case "expired":
    case "failed":
      return "That payment never completed, so the spot isn't held. Place the bid again.";
    default:
      return "That bid can't take artwork.";
  }
}

export async function POST(req: Request): Promise<Response> {
  const jar = await cookies();
  const bidderId = verifyBidderCookie(jar.get(SESSION_COOKIE)?.value);
  if (!bidderId) {
    return NextResponse.json(
      { error: "Open this page in the browser you bid from — we couldn't tell who you are." },
      { status: 401 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "That upload wasn't a readable form." }, { status: 400 });
  }

  const bidId = form.get("bidId");
  if (typeof bidId !== "string" || bidId.length === 0) {
    return NextResponse.json({ error: "No bid was named for this logo." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was attached." }, { status: 400 });
  }

  const bid = getBidById(bidId);
  // One answer for "no such bid" and "not your bid": otherwise this endpoint
  // tells a stranger which bid ids exist.
  if (!bid || bid.bidderId !== bidderId) {
    return NextResponse.json(
      { error: "We couldn't find that bid on your account." },
      { status: 404 },
    );
  }

  if (bid.status !== "paid" && bid.status !== "won") {
    return NextResponse.json({ error: blockedBecause(bid.status) }, { status: 409 });
  }

  // Checked before the body is buffered; validateUpload checks it again against
  // the real byte count, which is the number that actually decides.
  if (file.size > AUCTION.maxLogoBytes) {
    return NextResponse.json(
      { error: `Logos must be ${MAX_MB} MB or smaller.`, reason: "too_large" },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const validation = validateUpload({
    filename: file.name,
    mimeType: file.type,
    byteSize: file.size,
    bytes,
  });
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.message, reason: validation.reason },
      { status: 400 },
    );
  }

  try {
    const artwork = storeArtwork({
      bidId: bid.id,
      spotId: bid.spotId,
      bidderId,
      filename: file.name,
      mimeType: file.type,
      bytes,
    });
    return NextResponse.json(
      { ok: true, artworkId: artwork.id, reviewStatus: artwork.reviewStatus },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    // Only reachable if the two validations disagree, which would be a bug here
    // rather than a bad file — but the uploader still gets the readable reason.
    if (err instanceof UploadValidationError) {
      return NextResponse.json(
        { error: err.rejection.message, reason: err.rejection.reason },
        { status: 400 },
      );
    }
    console.error(`[artwork] storing upload for bid ${bid.id} failed:`, err);
    return NextResponse.json(
      { error: "We couldn't save that file. Try again in a moment." },
      { status: 500 },
    );
  }
}
