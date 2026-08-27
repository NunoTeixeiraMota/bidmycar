/**
 * The car and the spots on it.
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
 * Costing
 *
 * Every spot opens at the same price (AUCTION.openingPriceCents), whatever
 * size it is: the bidding decides what a panel is worth, not us.
 *
 * The rates below no longer set that opening price. They are kept because they
 * are what a spot actually costs to produce, which is worth knowing when
 * deciding whether a winning bid covers its own vinyl.
 *
 * Rates are the mid-market figures for one-off custom vehicle graphics; see
 * README for sources.
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

/* SPOTS:START -- rewritten by `npm run spots:export`; edit by hand or by
   dragging in /admin, but keep these two markers where they are. */
export const SPOTS: readonly SpotDefinition[] = [
  {
    key: "front-side", name: "Front side", panel: "Front side",
    blurb: "",
    x: 79.34, y: 44.427, w: 10, h: 10, difficulty: "mild",
  },
  {
    key: "front-lower", name: "Front lower wing", panel: "Lower front wing",
    blurb: "Below the swage line, ahead of the wheel. A classic rally sponsor position.",
    x: 67.372, y: 58.842, w: 7.472, h: 7.567, difficulty: "curved",
  },
  {
    key: "front-wing", name: "Front wing", panel: "Front nearside wing",
    blurb: "Ahead of the door, above the front wheel. Reads clearly in three-quarter shots.",
    x: 67.08, y: 45.367, w: 10.674, h: 11.711, difficulty: "curved",
  },
  {
    key: "door-main", name: "Door panel", panel: "Driver's door",
    blurb: "The largest flat panel on the car and the one every photograph is framed around.",
    x: 47.55, y: 45.88, w: 18.624, h: 22.211, difficulty: "flat",
  },
  {
    key: "rear-quarter-bottom", name: "rear quarter bottom", panel: "Rear Quarter Bottom",
    blurb: "",
    x: 30.66, y: 55.55, w: 10, h: 10, difficulty: "flat",
  },
  {
    key: "rear-quarter", name: "Rear quarter", panel: "Rear quarter panel",
    blurb: "The fastback's broadest shoulder, directly beneath the signature vents.",
    x: 30.627, y: 40.945, w: 10.674, h: 10.81, difficulty: "curved",
  },
  {
    key: "sill", name: "Rocker banner", panel: "Sill",
    blurb: "A full-length banner running the wheelbase. Long, low, and unmissable in profile.",
    x: 30.255, y: 69.892, w: 42.53, h: 9.118, difficulty: "mild",
  },
  {
    key: "quarter-glass", name: "Quarter glass", panel: "Rear side window",
    blurb: "Cut vinyl on glass. Cheapest to apply and the easiest to remove cleanly.",
    x: 29.539, y: 17.848, w: 10.926, h: 12.067, difficulty: "glass",
  },
  {
    key: "tailgate", name: "Tailgate", panel: "Rear panel",
    blurb: "Above the DATSUN 100A script. What everyone behind you reads at the lights.",
    x: 20.675, y: 41.387, w: 7.472, h: 6.126, difficulty: "curved",
  },
  {
    key: "rear-lower", name: "Rear lower quarter", panel: "Lower rear quarter",
    blurb: "Behind the rear wheel, above the bumper. Small, tucked away, and cheap.",
    x: 20.64, y: 49.755, w: 6.404, h: 6.847, difficulty: "curved",
  },
  {
    key: "rear-quarter-2", name: "Rear Quarter 2", panel: "Rear Quarter 2",
    blurb: "",
    x: 11.918, y: 36.935, w: 8.302, h: 21.314, difficulty: "mild",
  },
  {
    key: "fuel-cap", name: "Fuel Cap", panel: "Fuel Cap",
    blurb: "",
    x: 7.516, y: 50.657, w: 4.025, h: 8.471, difficulty: "mild",
  },
];
/* SPOTS:END */

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

/**
 * Photo percentages -> real centimetres -> what this spot costs to produce.
 *
 * `floorPriceCents` here is a COST ESTIMATE, not the price a spot opens at.
 * Spots all open at AUCTION.openingPriceCents; this is what it would cost to
 * cut and fit the vinyl, which the admin console shows for reference.
 */
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
  // Round to the nearest €5: a floor price of "€117.43" reads as a machine
  // guessing rather than a shop quoting.
  const floorPriceCents = Math.round(totalEur / 5) * 5 * 100;

  return { widthCm, heightCm, areaSqft, materialEur, installEur, floorPriceCents };
}

export const AUCTION = {
  /** Set at seed time; the auction runs this long. */
  durationHours: 12 * 24,
  /**
   * What every spot opens at, regardless of its size or which panel it is on.
   * The bidding is what prices prominence; a big flat door and a small awkward
   * roundel start level and it is up to bidders which one is worth more.
   */
  openingPriceCents: 500,
  /** A bid inside this window pushes the close out, per spot. */
  snipeWindowMs: 5 * 60 * 1000,
  extensionMs: 5 * 60 * 1000,
  maxExtensions: 60,
  /** Uploaded artwork limits. */
  maxLogoBytes: 5 * 1024 * 1024,
  acceptedLogoTypes: ["image/png", "image/svg+xml", "image/jpeg", "image/webp"],
} as const;
