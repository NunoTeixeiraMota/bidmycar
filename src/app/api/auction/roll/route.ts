import { NextResponse } from "next/server";

import { getBidRoll } from "@/lib/auction";

/**
 * Everyone who has ever paid, biggest bid first.
 *
 * This is deliberately not part of the auction state that the SSE stream pushes
 * every couple of seconds: the roll only grows, and re-sending the whole
 * history of the auction on every tick would cost more bandwidth than the board
 * it is attached to. Clients read it once and again whenever money moves.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(
      { entries: getBidRoll() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    console.error("[roll] could not read the roll:", err);
    return NextResponse.json({ error: "The roll is unavailable." }, { status: 503 });
  }
}
