import { NextResponse } from "next/server";

import { getBidRoll } from "@/lib/auction";

/**
 * Everyone who has ever paid, biggest bid first.
 *
 * This is deliberately not part of the auction state that the SSE stream pushes
 * every couple of seconds: the roll only grows, and re-sending the whole
 * history of the auction on every tick would cost more bandwidth than the board
 * it is attached to. Clients read it once and again whenever money moves.
 *
 * Paged by offset rather than by cursor. The ordering is by amount and can have
 * a new row inserted into the middle of it at any moment, so no cursor would be
 * stable anyway; `total` is returned so the client can tell whether it has the
 * lot without asking for a page it does not need.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** A query parameter is whatever the caller typed. Clamp, never trust. */
function positiveInt(raw: string | null, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;
    const limit = positiveInt(params.get("limit"), DEFAULT_LIMIT, MAX_LIMIT) || DEFAULT_LIMIT;
    const offset = positiveInt(params.get("offset"), 0, Number.MAX_SAFE_INTEGER);

    const all = getBidRoll();
    const entries = all.slice(offset, offset + limit);

    return NextResponse.json(
      {
        entries,
        total: all.length,
        offset,
        limit,
        hasMore: offset + entries.length < all.length,
        /** Every bid ever taken, added up. Not a page total: the footer shows
         *  what the car has been paid, which does not change with paging. */
        totalPaidCents: all.reduce((sum, entry) => sum + entry.amountCents, 0),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[roll] could not read the roll:", err);
    return NextResponse.json({ error: "The roll is unavailable." }, { status: 503 });
  }
}
