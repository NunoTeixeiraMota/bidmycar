import { AUCTION, metricsFor } from "@/config/car";
import { definitionOf } from "@/lib/auction";
import { countAllBidsForSpot, updateSpot } from "@/lib/db";
import type { Spot } from "@/lib/types";

/**
 * Shared by the admin spot routes.
 *
 * This lives outside the route files because a Next route module may export
 * only route handlers; two copies of the pricing rule is exactly the kind of
 * duplication that ends with the two of them disagreeing.
 */

/** A box is a percentage of the photo, and this is the smallest side that can
 *  still be found and grabbed in the editor. */
export const MIN_SIDE = 0.5;

/**
 * What the console needs to draw a row, and to know what it may do to it.
 *
 * The box reported is the effective one, not the raw override: the editor draws
 * boxes and cannot draw a null, so a spot still using the shipped survey has to
 * come back carrying the survey's numbers. `overridden` is what distinguishes
 * the two.
 */
export function reportOf(spot: Spot) {
  const definition = definitionOf(spot);
  const measured = metricsFor(definition);
  const bidCount = countAllBidsForSpot(spot.id);

  return {
    key: spot.key,
    name: spot.name,
    panel: spot.panel,
    blurb: spot.blurb,
    x: definition.x,
    y: definition.y,
    w: definition.w,
    h: definition.h,
    shape: definition.shape ?? "rect",
    difficulty: definition.difficulty,
    /** True when this spot carries its own box rather than the survey's. */
    overridden: spot.x !== null,
    floorPriceCents: spot.floorPriceCents,
    widthCm: Math.round(measured.widthCm * 10) / 10,
    heightCm: Math.round(measured.heightCm * 10) / 10,
    /** What the vinyl and its fitting would actually cost for this box. Shown
     *  for reference only: the opening price is flat and does not follow it. */
    productionCostCents: measured.floorPriceCents,
    bidCount,
    /** A spot with money against it can be renamed and moved, never deleted. */
    deletable: bidCount === 0,
  };
}

/**
 * Bring a spot's stored measurements back in line with its box.
 *
 * Only the centimetres move. Every spot opens at the same price whatever its
 * size, so there is nothing to re-quote; and a spot that has taken money is
 * left entirely alone, because someone bid against the number on its row.
 */
export function remeasureIfUntouched(spot: Spot): Spot {
  if (countAllBidsForSpot(spot.id) > 0) return spot;
  const measured = metricsFor(definitionOf(spot));
  return (
    updateSpot(spot.id, {
      floorPriceCents: AUCTION.openingPriceCents,
      widthCm: measured.widthCm,
      heightCm: measured.heightCm,
    }) ?? spot
  );
}

/** Percentages that put an edge past the photo would draw a hotspot half off
 *  the car. Name the spot rather than saying "invalid". */
export function offPhoto(box: {
  key?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}): string | null {
  const what = box.key ?? "That spot";
  if (box.x + box.w > 100) return `${what} runs past the right edge of the photo.`;
  if (box.y + box.h > 100) return `${what} runs past the bottom edge of the photo.`;
  return null;
}
