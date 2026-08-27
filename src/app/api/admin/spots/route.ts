import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { AUCTION, metricsFor } from "@/config/car";
import { getSpotByKey, insertSpot, listSpots, transaction, updateSpot } from "@/lib/db";
import { MIN_SIDE, offPhoto, reportOf, remeasureIfUntouched } from "@/lib/spot-admin";
import type { Spot } from "@/lib/types";

/**
 * Where the spots are, and what they are.
 *
 * The survey in src/config/car.ts is measured off the photograph by hand and is
 * still the default for the spots that came from it. This endpoint is how that
 * gets corrected, and how spots that were never in the survey get added: what
 * it writes is the database row, which is what the board reads.
 *
 * Moving a spot never moves its price. Every spot opens at the same figure and
 * the bidding does the rest, so resizing a panel changes what gets cut in
 * vinyl, not what it costs to take.
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

const DIFFICULTY = z.enum(["flat", "glass", "mild", "curved"]);

const Box = z.object({
  key: z.string().min(1),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().min(MIN_SIDE).max(100),
  h: z.number().min(MIN_SIDE).max(100),
  shape: z.enum(["rect", "ellipse"]).optional(),
});

const PatchBody = z.union([
  z.object({ reset: z.literal(true) }),
  z.object({ reset: z.literal(false).optional(), spots: z.array(Box).min(1).max(64) }),
]);

/**
 * A key is a URL fragment and a DOM id on the public board, so it is restricted
 * to the shape those can carry rather than sanitised after the fact.
 */
const KEY_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const CreateBody = z.object({
  key: z.string().trim().min(2).max(48).regex(KEY_SHAPE, {
    message: "A key is lower-case letters, numbers and single hyphens, like 'rear-quarter'.",
  }),
  name: z.string().trim().min(1).max(60),
  panel: z.string().trim().min(1).max(60),
  blurb: z.string().trim().max(400).optional(),
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  w: z.number().min(MIN_SIDE).max(100),
  h: z.number().min(MIN_SIDE).max(100),
  shape: z.enum(["rect", "ellipse"]).optional(),
  difficulty: DIFFICULTY.optional(),
});

/**
 * GET: every spot as the console needs it, including the two things the public
 * board has no business carrying: how hard each panel is to fit, and how many
 * bids stand against it.
 */
export async function GET(req: Request): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  return NextResponse.json({ spots: listSpots().map(reportOf) });
}

/**
 * PATCH: write the boxes, or clear every override and fall back to the survey.
 *
 * All spots move in one transaction. A partial save would leave the board with
 * some panels in their new positions and some in their old, which is worse than
 * either and impossible to tell apart from a bug.
 */
export async function PATCH(req: Request): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  const raw: unknown = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Expected { spots: [{ key, x, y, w, h, shape? }] } or { reset: true }." },
      { status: 400 },
    );
  }

  if ("reset" in parsed.data && parsed.data.reset === true) {
    const restored = transaction(() =>
      listSpots().map((spot) => {
        const cleared =
          updateSpot(spot.id, { x: null, y: null, w: null, h: null, shape: null }) ?? spot;
        return remeasureIfUntouched(cleared);
      }),
    );

    return NextResponse.json({
      reset: true,
      updated: restored.length,
      spots: restored.map(reportOf),
    });
  }

  const boxes = parsed.data.spots;

  // Everything is checked before anything is written, so a rejected save leaves
  // the board exactly as the console last drew it.
  const keys = new Set<string>();
  for (const box of boxes) {
    if (keys.has(box.key)) {
      return NextResponse.json({ error: `${box.key} appears twice.` }, { status: 400 });
    }
    keys.add(box.key);

    const complaint = offPhoto(box);
    if (complaint) return NextResponse.json({ error: complaint }, { status: 400 });

    if (!getSpotByKey(box.key)) {
      return NextResponse.json({ error: `No spot called ${box.key}.` }, { status: 404 });
    }
  }

  const saved = transaction(() => {
    const out: Spot[] = [];
    for (const box of boxes) {
      const spot = getSpotByKey(box.key);
      if (!spot) continue;
      const moved = updateSpot(spot.id, {
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        shape: box.shape ?? spot.shape,
      });
      if (moved) out.push(remeasureIfUntouched(moved));
    }
    return out;
  });

  return NextResponse.json({ updated: saved.length, spots: saved.map(reportOf) });
}

/**
 * POST: add a spot that was never in the survey.
 *
 * It opens on the same clock as everything else, because the whole auction
 * closes together and a spot with a later deadline would quietly break that.
 */
export async function POST(req: Request): Promise<Response> {
  const gate = requireAdmin(req);
  if (!gate.ok) return gate.response;

  const raw: unknown = await req.json().catch(() => null);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "That spot could not be read." },
      { status: 400 },
    );
  }

  const input = parsed.data;

  const complaint = offPhoto(input);
  if (complaint) return NextResponse.json({ error: complaint }, { status: 400 });

  if (getSpotByKey(input.key)) {
    return NextResponse.json(
      { error: `There is already a spot called ${input.key}.` },
      { status: 409 },
    );
  }

  const existing = listSpots();
  // Every spot closes together. Match the others rather than starting a fresh
  // clock, and fall back to a full run only when this is the first spot.
  const closesAt =
    existing.length > 0
      ? Math.max(...existing.map((spot) => spot.closesAt))
      : Date.now() + AUCTION.durationHours * 60 * 60 * 1000;

  const measured = metricsFor({
    key: input.key,
    name: input.name,
    panel: input.panel,
    blurb: input.blurb ?? "",
    x: input.x,
    y: input.y,
    w: input.w,
    h: input.h,
    shape: input.shape,
    difficulty: input.difficulty ?? "mild",
  });

  const spot = insertSpot({
    key: input.key,
    name: input.name,
    panel: input.panel,
    blurb: input.blurb ?? "",
    // Every spot opens at the same price whatever its size; `measured` is only
    // consulted for the real-world centimetres.
    floorPriceCents: AUCTION.openingPriceCents,
    widthCm: measured.widthCm,
    heightCm: measured.heightCm,
    x: input.x,
    y: input.y,
    w: input.w,
    h: input.h,
    shape: input.shape ?? "rect",
    difficulty: input.difficulty ?? "mild",
    closesAt,
  });

  return NextResponse.json({ spot: reportOf(spot) }, { status: 201 });
}
