/**
 * Domain contracts.
 *
 * MONEY RULE: every monetary value is an integer number of cents. Floats never
 * touch money: not in the DB, not in the engine, not in an API payload.
 * Formatting happens only at the render edge, via `formatMoney` in ./money.
 *
 * THE MODEL: the car is not for sale. Eleven regions of its bodywork are.
 * A bidder pays to hold a spot; if someone outbids them the spot changes hands
 * and, as the published conditions say, their payment is not returned. Whoever
 * holds a spot when the clock stops gets their logo cut in vinyl and applied to
 * the real car.

 * NOTE: the engine below still refunds displaced bids at close. The site copy
 * says otherwise, deliberately and on request; reconciling the two is a
 * separate piece of work.
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
  /**
   * Optional website, shown as a link on the public roll. Stored only after it
   * has been normalised to an http(s) URL, because this value ends up in an
   * href on a page anyone can read.
   */
  link: string | null;
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

/**
 * The persisted half of a spot.
 *
 * Geometry ships in src/config/car.ts and is the default. The five nullable
 * fields below are the admin console's override, written when someone drags or
 * resizes a spot on the car; null in all of them means "use the shipped
 * measurement". Keeping the config as the floor means a bad edit is always one
 * reset away from the original survey.
 */
export interface Spot {
  id: string;
  key: string;
  name: string;
  panel: string;
  blurb: string;
  floorPriceCents: number;
  widthCm: number;
  heightCm: number;
  /** Percentage of the photo's width/height, or null to use the config. */
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  shape: "rect" | "ellipse" | null;
  /**
   * How awkward this panel is to lay vinyl on, which is what scales the labour
   * half of the floor price. Null falls back to the shipped survey; a spot the
   * admin console created has no survey, so it always carries its own.
   */
  difficulty: "flat" | "glass" | "mild" | "curved" | null;
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
    /** True when artwork is uploaded but not yet approved; the UI shows a
     *  pending marker rather than the logo, mirroring "under review". */
    artworkPending: boolean;
  } | null;
}

/**
 * One paid bid, as the public roll shows it.
 *
 * Every bid that ever took money is on the roll, including the ones that were
 * later outbid: those are not refunded, so they are money this car was paid and
 * they belong on the list as much as a winning bid does.
 */
export interface RollEntry {
  bidId: string;
  displayName: string;
  /** Normalised http(s) URL, or null when the bidder gave none. */
  link: string | null;
  /** Only set once a human approved the artwork on this bid. */
  logoUrl: string | null;
  spotKey: string;
  spotName: string;
  amountCents: number;
  paidAt: number;
  /** True when this bid still holds its spot. */
  holding: boolean;
}

/** One payload driving the whole board. */
export interface AuctionState {
  spots: SpotView[];
  totalRaisedCents: number;
  spotsTaken: number;
  spotsTotal: number;
  /** When bidding stops. Every spot closes together, so this is the deadline. */
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
