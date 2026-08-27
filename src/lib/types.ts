/**
 * Domain contracts.
 *
 * MONEY RULE: every monetary value is an integer number of cents. Floats never
 * touch money — not in the DB, not in the engine, not in an API payload.
 * Formatting happens only at the render edge, via `formatMoney` in ./money.
 *
 * THE MODEL: the car is not for sale. Eleven regions of its bodywork are.
 * A bidder pays to hold a spot; if someone outbids them they are refunded and
 * the spot changes hands. Whoever holds a spot when the clock stops gets their
 * logo cut in vinyl and applied to the real car.
 */

export type Currency = "EUR";

/* ------------------------------------------------------------------ *
 * Bidders
 * ------------------------------------------------------------------ */

export interface Bidder {
  id: string;
  email: string;
  /** Shown publicly beside the spots they hold. */
  displayName: string;
  stripeCustomerId: string | null;
  createdAt: number;
}

/* ------------------------------------------------------------------ *
 * Bids
 * ------------------------------------------------------------------ */

/**
 * Payment happens at bid time, not at auction close.
 *
 * This is forced by the calendar, not chosen for convenience: Stripe releases
 * an uncaptured card authorisation after roughly seven days, and this auction
 * runs for twelve. An authorise-now-capture-later design would quietly drop
 * every hold placed in the first five days. So a bid is a real charge, and
 * being outbid produces a real refund.
 */
export type BidStatus =
  | "pending_payment" // checkout session open; not yet money
  | "paid"            // settled; this bid may hold the spot
  | "outbid"          // beaten; refund not yet confirmed by Stripe
  | "refunded"        // beaten and the money is back
  | "won"             // held the spot when the auction closed
  | "expired"         // checkout abandoned or timed out
  | "failed";         // payment declined

/** A bid only counts toward a spot's price once it is in one of these states. */
export const LIVE_BID_STATUSES: readonly BidStatus[] = ["paid", "won"];

export interface Bid {
  id: string;
  spotId: string;
  bidderId: string;
  amountCents: number;
  status: BidStatus;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  stripeRefundId: string | null;
  createdAt: number;
  paidAt: number | null;
  refundedAt: number | null;
  /** Monotonic per spot; breaks ties between equal amounts, earliest wins. */
  sequence: number;
}

/* ------------------------------------------------------------------ *
 * Artwork
 * ------------------------------------------------------------------ */

/**
 * A logo is only shown on the car once a human has approved it. The car is a
 * real object in a real street, and an unmoderated upload pipeline that
 * composites straight onto the hero image is an obvious abuse vector.
 */
export type ReviewStatus = "awaiting_upload" | "pending" | "approved" | "rejected";

export interface Artwork {
  id: string;
  bidId: string;
  spotId: string;
  bidderId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  /** Path relative to the upload root, never an absolute filesystem path. */
  storedPath: string;
  reviewStatus: ReviewStatus;
  rejectionReason: string | null;
  createdAt: number;
  reviewedAt: number | null;
}

/* ------------------------------------------------------------------ *
 * Spots
 * ------------------------------------------------------------------ */

export type SpotStatus = "open" | "held" | "closed";

/** The persisted half of a spot. Geometry lives in src/config/car.ts. */
export interface Spot {
  id: string;
  key: string;
  name: string;
  panel: string;
  blurb: string;
  floorPriceCents: number;
  widthCm: number;
  heightCm: number;
  status: SpotStatus;
  /** Per-spot clock. Anti-snipe extends one spot, not the whole auction. */
  closesAt: number;
  extensionCount: number;
  createdAt: number;
}

/** A spot as the public interface sees it. */
export interface SpotView {
  key: string;
  name: string;
  panel: string;
  blurb: string;
  /** Geometry as a percentage of the car photo, for absolute positioning. */
  x: number;
  y: number;
  w: number;
  h: number;
  shape: "rect" | "ellipse";
  widthCm: number;
  heightCm: number;

  floorPriceCents: number;
  /** Floor price until someone pays; then the standing top bid. */
  currentPriceCents: number;
  minimumNextBidCents: number;
  bidCount: number;
  status: SpotStatus;
  closesAt: number;
  inExtensionWindow: boolean;

  /** Present once a paid bid holds the spot. */
  holder: {
    displayName: string;
    since: number;
    /** Only set once artwork exists AND a human approved it. */
    logoUrl: string | null;
    /** True when artwork is uploaded but not yet approved — the UI shows a
     *  pending marker rather than the logo, mirroring "under review". */
    artworkPending: boolean;
  } | null;
}

/** One payload driving the whole board. */
export interface AuctionState {
  spots: SpotView[];
  totalRaisedCents: number;
  goalCents: number;
  goalPercent: number;
  spotsTaken: number;
  spotsTotal: number;
  /** The earliest spot close — what the headline countdown shows. */
  closesAt: number;
  /** Server clock at render time. Clients offset against this rather than
   *  trusting their own, which may be minutes out. */
  serverNow: number;
  allClosed: boolean;
}

/* ------------------------------------------------------------------ *
 * Bidding
 * ------------------------------------------------------------------ */

export type BidRejectionReason =
  | "spot_unknown"
  | "spot_closed"
  | "auction_closed"
  | "below_minimum"
  | "already_holding"
  | "amount_invalid"
  | "bidder_unknown"
  | "stripe_unavailable";

export type StartBidResult =
  | {
      ok: true;
      bidId: string;
      /** Where the browser is sent to pay. Null in demo mode, where the bid
       *  settles immediately and the caller should just refresh. */
      checkoutUrl: string | null;
      /** True when no Stripe keys are configured and the bid was settled
       *  without taking money. */
      demo: boolean;
    }
  | {
      ok: false;
      reason: BidRejectionReason;
      message: string;
      minimumNextBidCents?: number;
    };

/** What settling a paid bid did to the spot. */
export interface SettlementResult {
  bidId: string;
  spotKey: string;
  becameHolder: boolean;
  /** The bid this one displaced, now owed a refund. */
  displacedBidId: string | null;
  extendedClosesAt: number | null;
}

export interface CloseResult {
  closedSpots: number;
  winners: Array<{ spotKey: string; bidId: string; bidderId: string; amountCents: number }>;
  /** Bids that must be refunded because they were outbid but never settled. */
  refundedBidIds: string[];
}
