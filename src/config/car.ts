/**
 * The car, the spots on it, and how a spot's floor price is derived.
 *
 * Editing this file is how you list a different vehicle: replace the photo,
 * re-measure the spots against it, and everything downstream follows.
 */

export const CAR = {
  name: "Datsun 100A",
  subtitle: "1974 · Cherry E10 · Two-door coupé",
  /** Real overall length, used to convert image percentages into centimetres. */
  lengthMm: 3830,
  /** The fraction of the photo's WIDTH the car actually spans, measured off the
   *  source image. Without this the cm conversion would be wrong by the size of
   *  the empty studio background either side of the car. */
  spanFraction: 0.94996,
  photo: "/car/board.png",
  photoWidth: 1410,
  photoHeight: 580,
} as const;

/* ------------------------------------------------------------------ *
 * Pricing
 *
 * A spot opens at what it genuinely costs to put that logo on the car:
 * artwork setup, the vinyl itself, and the labour to apply it to painted
 * bodywork. Nothing above that is asked for at the floor — prominence is
 * priced by the bidding, not by us.
 *
 * Rates below are the mid-market figures for one-off custom vehicle
 * graphics; see README for sources.
 * ------------------------------------------------------------------ */

export const VINYL_PRICING = {
  /** Artwork prep and cut-file production, ~30 min at a €70/h shop rate. */
  setupEur: 35,
  /** Printed + laminated cast vinyl, mid of the €10–15/sq ft market range. */
  materialEurPerSqft: 12,
  /** Application: a call-out minimum plus time that scales with area. */
  installBaseEur: 35,
  installEurPerSqft: 45,
  /**
   * Application difficulty. Flat glass is quickest; a compound-curved wing or a
   * small precise roundel takes materially longer and risks a scrapped cut.
   */
  difficulty: { flat: 1.0, glass: 0.9, mild: 1.12, curved: 1.27 },
} as const;

export type Difficulty = keyof typeof VINYL_PRICING.difficulty;

/** One region of bodywork, measured as a percentage of the photo. */
export interface SpotDefinition {
  key: string;
  name: string;
  panel: string;
  blurb: string;
  /** Top-left corner and size, as a percentage of the photo's width/height. */
  x: number;
  y: number;
  w: number;
  h: number;
  difficulty: Difficulty;
  /** Circular spots (the racing roundel) are masked to an ellipse when a logo
   *  is composited, and their billed area is reduced accordingly. */
  shape?: "rect" | "ellipse";
}

export const SPOTS: readonly SpotDefinition[] = [
  {
    key: "door-main", name: "Door panel", panel: "Driver's door",
    blurb: "The largest flat panel on the car and the one every photograph is framed around.",
    x: 48.934, y: 53.677, w: 14.41, h: 14.414, difficulty: "flat",
  },
  {
    key: "front-wing", name: "Front wing", panel: "Front nearside wing",
    blurb: "Ahead of the door, above the front wheel. Reads clearly in three-quarter shots.",
    x: 67.08, y: 48.272, w: 10.674, h: 11.711, difficulty: "curved",
  },
  {
    key: "rear-quarter", name: "Rear quarter", panel: "Rear quarter panel",
    blurb: "The fastback's broadest shoulder, directly beneath the signature vents.",
    x: 14.778, y: 39.263, w: 10.674, h: 10.81, difficulty: "curved",
  },
  {
    key: "sill", name: "Rocker banner", panel: "Sill",
    blurb: "A full-length banner running the wheelbase. Long, low, and unmissable in profile.",
    x: 30.255, y: 69.892, w: 28.819, h: 4.684, difficulty: "mild",
  },
  {
    key: "quarter-glass", name: "Quarter glass", panel: "Rear side window",
    blurb: "Cut vinyl on glass. Cheapest to apply and the easiest to remove cleanly.",
    x: 26.52, y: 23.047, w: 10.674, h: 9.009, difficulty: "glass",
  },
  {
    key: "roundel", name: "Racing roundel", panel: "Front wing roundel",
    blurb: "The competition number circle. Small, central, and the most looked-at spot on the car.",
    x: 77.22, y: 30.795, w: 4.483, h: 6.486, difficulty: "curved", shape: "ellipse",
  },
  {
    key: "bonnet", name: "Bonnet", panel: "Bonnet",
    blurb: "The nose. Seen head-on and from the driver's seat of the car behind.",
    x: 82.023, y: 38.362, w: 7.472, h: 5.766, difficulty: "mild",
  },
  {
    key: "front-lower", name: "Front lower wing", panel: "Lower front wing",
    blurb: "Below the swage line, ahead of the wheel. A classic rally sponsor position.",
    x: 79.888, y: 55.478, w: 7.472, h: 7.567, difficulty: "curved",
  },
  {
    key: "tailgate", name: "Tailgate", panel: "Rear panel",
    blurb: "Above the DATSUN 100A script. What everyone behind you reads at the lights.",
    x: 5.706, y: 40.164, w: 7.472, h: 6.126, difficulty: "curved",
  },
  {
    key: "rear-lower", name: "Rear lower quarter", panel: "Lower rear quarter",
    blurb: "Behind the rear wheel, above the bumper. Small, tucked away, and cheap.",
    x: 7.307, y: 59.082, w: 6.404, h: 6.847, difficulty: "curved",
  },
  {
    key: "roof", name: "Roof", panel: "Roof",
    blurb:
      "Edge-on in profile, but the whole panel from above — and the only spot that " +
      "shows in a drone shot or a multi-storey car park.",
    x: 44.131, y: 10.976, w: 13.876, h: 5.045, difficulty: "mild",
  },
];

/* ------------------------------------------------------------------ *
 * Derived geometry and price
 * ------------------------------------------------------------------ */

const MM_PER_PX = CAR.lengthMm / (CAR.photoWidth * CAR.spanFraction);

export interface SpotMetrics {
  widthCm: number;
  heightCm: number;
  areaSqft: number;
  materialEur: number;
  installEur: number;
  floorPriceCents: number;
}

/** Photo percentages -> real centimetres -> honest floor price. */
export function metricsFor(spot: SpotDefinition): SpotMetrics {
  const widthCm = ((spot.w / 100) * CAR.photoWidth * MM_PER_PX) / 10;
  const heightCm = ((spot.h / 100) * CAR.photoHeight * MM_PER_PX) / 10;

  // An ellipse covers pi/4 of its bounding box; billing the full rectangle for
  // a roundel would overcharge by a quarter.
  const coverage = spot.shape === "ellipse" ? Math.PI / 4 : 1;
  const areaSqft = (widthCm * heightCm * coverage) / 929.03;

  const p = VINYL_PRICING;
  const materialEur = areaSqft * p.materialEurPerSqft;
  const installEur =
    (p.installBaseEur + areaSqft * p.installEurPerSqft) * p.difficulty[spot.difficulty];

  const totalEur = p.setupEur + materialEur + installEur;
  // Round to the nearest €5 — a floor price of "€117.43" reads as a machine
  // guessing rather than a shop quoting.
  const floorPriceCents = Math.round(totalEur / 5) * 5 * 100;

  return { widthCm, heightCm, areaSqft, materialEur, installEur, floorPriceCents };
}

export const AUCTION = {
  /** Set at seed time; the auction runs this long. */
  durationHours: 12 * 24,
  /**
   * Total the seller needs to cover having the whole car wrapped and the
   * platform's costs. Drives the progress bar; purely presentational.
   */
  goalCents: 250_000,
  /** A bid inside this window pushes the close out, per spot. */
  snipeWindowMs: 5 * 60 * 1000,
  extensionMs: 5 * 60 * 1000,
  maxExtensions: 60,
  /** Uploaded artwork limits. */
  maxLogoBytes: 5 * 1024 * 1024,
  acceptedLogoTypes: ["image/png", "image/svg+xml", "image/jpeg", "image/webp"],
} as const;
