import { NextResponse } from "next/server";

import { getAuctionState } from "@/lib/auction";

/**
 * The whole board, once.
 *
 * `nodejs` because the read goes through better-sqlite3, a native addon that
 * cannot load on the edge runtime; `force-dynamic` because a prerendered copy
 * of this route would serve build-time prices and a dead countdown to everyone.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return NextResponse.json(getAuctionState(Date.now()), {
    // Prices, holders and clocks. A cached copy of this is a wrong copy, and a
    // bidder acting on one would be bidding against a spot that has moved.
    headers: { "cache-control": "no-store" },
  });
}
