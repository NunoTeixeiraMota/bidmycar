import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";

import { getArtworkById } from "@/lib/db";
import { SESSION_COOKIE, verifyBidderCookie } from "@/lib/session";
import { readArtworkBytes } from "@/lib/uploads";

/**
 * The bytes of one uploaded logo.
 *
 * Uploads live outside public/ precisely so this check exists: a file is
 * readable only once a human approved it, or by the bidder who sent it, or by
 * an admin reviewing the queue. Anyone else gets 404 rather than 403 — a
 * private file should not confirm that it exists.
 *
 * An approved SVG is still a stranger's markup. `validateUpload` refuses the
 * dangerous constructs it can recognise, this route removes what any survivor
 * could do with them: nosniff pins the type, the CSP denies every fetch and
 * every script, and `readArtworkBytes` serves SVG as an attachment so a direct
 * navigation downloads instead of executing a document in our origin.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SVG_MIME = "image/svg+xml";

/** Everything an SVG might reach for, denied; inline style keeps it drawable. */
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/** An unset ADMIN_TOKEN means nobody is an admin, never that everybody is. */
function isAdmin(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected) return false;

  const presented = req.headers.get("x-admin-token")?.trim();
  if (!presented) return false;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function missing(): Response {
  return NextResponse.json({ error: "No such artwork." }, { status: 404 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  const artwork = getArtworkById(id);
  if (!artwork) return missing();

  const approved = artwork.reviewStatus === "approved";
  const jar = await cookies();
  const viewer = verifyBidderCookie(jar.get(SESSION_COOKIE)?.value);

  if (!approved && viewer !== artwork.bidderId && !isAdmin(req)) return missing();

  let payload;
  try {
    payload = readArtworkBytes(artwork);
  } catch (err) {
    // The row survived its file — a wiped upload directory, or a path we refuse
    // to resolve. Neither is something the caller can act on.
    console.error(`[artwork] ${artwork.id} (${artwork.storedPath}) could not be read:`, err);
    return missing();
  }

  const headers = new Headers({
    "content-type": payload.mimeType,
    "content-disposition": payload.contentDisposition,
    "content-length": String(payload.bytes.byteLength),
    "x-content-type-options": "nosniff",
    // Approval can be withdrawn, so an approved logo is cacheable only briefly.
    // Anything else is somebody's private file and must not be stored at all.
    "cache-control": approved ? "public, max-age=60" : "private, no-store",
    // The same URL answers 200 or 404 depending on who is asking.
    vary: "Cookie, x-admin-token",
  });
  if (payload.mimeType === SVG_MIME) headers.set("content-security-policy", SVG_CSP);

  // Copied out of the Buffer readFileSync handed back: that is a view over an
  // ArrayBufferLike Node may share with other allocations, and a Response body
  // has to own a plain ArrayBuffer.
  return new Response(new Uint8Array(payload.bytes), { status: 200, headers });
}
