import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

import { getArtworkById, getSpotById, updateArtwork } from "@/lib/db";

/**
 * Approve or reject one uploaded logo.
 *
 * This decision is the gate between a stranger's file and a vinyl cutter, so it
 * is a deliberate human act with a token behind it — nothing here is automated
 * and nothing is approved by default. Rejecting keeps the row and its reason:
 * the bidder is shown why, and re-uploading supersedes rather than erases.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Gate = { ok: true } | { ok: false; response: Response };

/**
 * The admin gate, repeated in each admin route because a route file may export
 * only route handlers — there is nowhere shared to put it that Next will accept.
 *
 * An unset ADMIN_TOKEN closes the console rather than opening it.
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

/** Shown to the bidder verbatim, so it is bounded and stripped of control chars. */
function cleanReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\p{Cc}/gu, " ").trim().slice(0, 500);
  return text.length > 0 ? text : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const decision = (body as { decision?: unknown } | null)?.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json(
      { error: `decision must be "approve" or "reject".` },
      { status: 400 },
    );
  }

  const artwork = getArtworkById(id);
  if (!artwork) return NextResponse.json({ error: "No such artwork." }, { status: 404 });

  const reason = cleanReason((body as { reason?: unknown }).reason);
  const updated = updateArtwork(artwork.id, {
    reviewStatus: decision === "approve" ? "approved" : "rejected",
    // Cleared on approval: a stale reason from an earlier rejection would be
    // shown beside a logo that is now on the car.
    rejectionReason: decision === "approve" ? null : reason,
    reviewedAt: Date.now(),
  });
  if (!updated) {
    return NextResponse.json({ error: "The decision could not be saved." }, { status: 500 });
  }

  const spot = getSpotById(updated.spotId);

  return NextResponse.json(
    {
      ok: true,
      artwork: {
        id: updated.id,
        bidId: updated.bidId,
        spotId: updated.spotId,
        spotKey: spot?.key ?? null,
        spotName: spot?.name ?? null,
        bidderId: updated.bidderId,
        filename: updated.filename,
        mimeType: updated.mimeType,
        byteSize: updated.byteSize,
        reviewStatus: updated.reviewStatus,
        rejectionReason: updated.rejectionReason,
        createdAt: updated.createdAt,
        reviewedAt: updated.reviewedAt,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
