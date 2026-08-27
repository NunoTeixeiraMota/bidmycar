import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { countAllBidsForSpot, deleteSpot, getSpotByKey, updateSpot } from "@/lib/db";
import { reportOf, remeasureIfUntouched } from "@/lib/spot-admin";

/**
 * One spot: rename it, or remove it.
 *
 * Deleting is guarded on money, not on status. A spot with any bid against it
 * is refused outright, because bids and artwork carry its id and SQLite is not
 * enforcing those references for us: removing the spot would leave rows nobody
 * can resolve, including a receipt someone paid for and can still open.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Gate = { ok: true } | { ok: false; response: Response };

/**
 * The admin gate, repeated in each admin route because a route file may export
 * only route handlers; there is nowhere shared to put it that Next will accept.
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

/**
 * The key is not editable. It is the handle the board, the bid receipts and the
 * artwork rows all hold this spot by; renaming it would strand every one of
 * them. The display name is what people read, and that is what changes here.
 */
const EditBody = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    panel: z.string().trim().min(1).max(60).optional(),
    blurb: z.string().trim().max(400).optional(),
    difficulty: z.enum(["flat", "glass", "mild", "curved"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Nothing to change.",
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  const { key } = await params;
  const spot = getSpotByKey(key);
  if (!spot) return NextResponse.json({ error: `No spot called ${key}.` }, { status: 404 });

  const raw: unknown = await req.json().catch(() => null);
  const parsed = EditBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "That change could not be read." },
      { status: 400 },
    );
  }

  const updated = updateSpot(spot.id, parsed.data);
  if (!updated) {
    return NextResponse.json({ error: "That spot could not be updated." }, { status: 500 });
  }

  // Difficulty feeds the production-cost estimate, not the opening price, so
  // this only refreshes the stored measurements.
  return NextResponse.json({ spot: reportOf(remeasureIfUntouched(updated)) });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  const { key } = await params;
  const spot = getSpotByKey(key);
  if (!spot) return NextResponse.json({ error: `No spot called ${key}.` }, { status: 404 });

  const bids = countAllBidsForSpot(spot.id);
  if (bids > 0) {
    return NextResponse.json(
      {
        error:
          `${spot.name} has ${bids} bid${bids === 1 ? "" : "s"} against it and cannot be ` +
          "deleted. Money and artwork are attached to it, and the people who paid can still " +
          "open their receipts.",
      },
      { status: 409 },
    );
  }

  if (!deleteSpot(spot.id)) {
    return NextResponse.json({ error: "That spot could not be deleted." }, { status: 500 });
  }

  return NextResponse.json({ deleted: spot.key });
}
