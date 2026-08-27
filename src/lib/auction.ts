import { AUCTION, SPOTS, metricsFor, type SpotDefinition } from "@/config/car";
import {
  db,
  getArtworkByBidId,
  getBidById,
  getBidderById,
  countSettledBidsForSpot,
  getPaidBidsForSpot,
  getSpotById,
  getSpotByKey,
  getTotalRaisedCents,
  insertBid,
  listPaidBids,
  listSpots,
  transaction,
  updateBid,
  updateSpot,
} from "@/lib/db";
import { BID_STEP_CENTS, MIN_BID_CENTS, formatMoney } from "@/lib/money";
import {
  LIVE_BID_STATUSES,
  type AuctionState,
  type Bid,
  type BidRejectionReason,
  type CloseResult,
  type RollEntry,
  type SettlementResult,
  type Spot,
  type SpotView,
} from "@/lib/types";

/**
 * The bidding engine: who holds which spot, for how much, and until when.
 *
 * Two-step lifecycle. A bid is CREATED as `pending_payment` when the bidder is
 * sent to Stripe, and SETTLED when Stripe confirms the money arrived. Only a
 * settled bid can hold a spot or move a price; otherwise anyone could freeze
 * a spot at an unreachable price by opening a checkout and walking away.
 *
 * Every mutation below runs in one transaction and re-reads the spot and its
 * bids from inside it. State read before the transaction opened is worthless:
 * a concurrent settlement may have changed the top bid in between.
 */

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export type AuctionErrorCode =
  | "bid_unknown"
  | "spot_missing"
  | "not_refundable"
  | "not_expirable"
  | "write_failed";

/** Thrown only for states the caller should never have reached: a rejected
 *  bid is a return value, not an exception. */
export class AuctionError extends Error {
  readonly code: AuctionErrorCode;

  constructor(code: AuctionErrorCode, message: string) {
    super(message);
    this.name = "AuctionError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * Pure ranking
 * ------------------------------------------------------------------ */

/** Settled bids best-first: highest amount, and on a tie the earlier sequence. */
function ranked(bids: Bid[]): Bid[] {
  return bids
    .filter((bid) => LIVE_BID_STATUSES.includes(bid.status))
    .sort((a, b) => b.amountCents - a.amountCents || a.sequence - b.sequence);
}

/**
 * The bids competing for a panel.
 *
 * Contention is a property of the bid, decided when it was placed, not
 * something re-derived from the amount now. That distinction matters: a bid of
 * 10.50 against a 10.00 holder is the larger number and still did not clear the
 * one-euro step, so ranking purely by amount would hand it a panel it never
 * won. Anything that did not clear the step is support: kept, charged, on the
 * public roll, never on the car.
 *
 * A null `contends` is a row from before the column existed. Those fall back to
 * the rule that was in force when they were written, which was simply "at or
 * above the spot's listed price".
 */
export function contendersOf(spot: Spot, bids: Bid[]): Bid[] {
  return ranked(bids).filter((bid) =>
    bid.contends === null ? bid.amountCents >= spot.floorPriceCents : bid.contends,
  );
}

/**
 * What a bid has to reach to take this panel.
 *
 * An untouched spot goes for exactly what it is listed at. Once somebody holds
 * it, taking it off them costs a full step more than they paid.
 */
export function priceToBeat(spot: Spot, bids: Bid[]): number {
  const holder = holderOf(spot, bids);
  return holder ? holder.amountCents + BID_STEP_CENTS : spot.floorPriceCents;
}

/**
 * The bid holding a spot: the highest contender, ties won by the earlier
 * sequence. Matching an existing bid is not beating it, so the incumbent keeps
 * the spot.
 */
export function holderOf(spot: Spot, bids: Bid[]): Bid | null {
  return contendersOf(spot, bids)[0] ?? null;
}

/**
 * The highest settled bid of any size, support included.
 *
 * This is not the holder. It exists for callers that genuinely want "the
 * biggest number on this spot" rather than "who owns the panel".
 */
export function topBidOf(bids: Bid[]): Bid | null {
  return ranked(bids)[0] ?? null;
}

/** What the spot stands at: its holder's bid, or the price it is listed at. */
export function priceOf(spot: Spot, bids: Bid[]): number {
  return holderOf(spot, bids)?.amountCents ?? spot.floorPriceCents;
}

/* ------------------------------------------------------------------ *
 * Placing a bid
 * ------------------------------------------------------------------ */

export interface StartBidInput {
  spotKey: string;
  bidderId: string;
  amountCents: number;
  now: number;
}

/** The engine's half of `StartBidResult`; the API layer adds the checkout URL. */
export type StartBidOutcome =
  | { ok: true; bid: Bid; spot: Spot }
  | {
      ok: false;
      reason: BidRejectionReason;
      message: string;
    };

function reject(reason: BidRejectionReason, message: string): StartBidOutcome {
  return { ok: false, reason, message };
}

/**
 * Validate and record an unpaid bid.
 *
 * The row created here is deliberately inert: it does not move the price, does
 * not displace the holder and does not extend the clock. All of that happens in
 * `settleBid`, once the money is real.
 */
export function startBid(input: StartBidInput): StartBidOutcome {
  const { spotKey, bidderId, amountCents, now } = input;

  return transaction(() => {
    const spot = getSpotByKey(spotKey);
    if (!spot) return reject("spot_unknown", `No spot named "${spotKey}".`);
    if (spot.status === "closed") return reject("spot_closed", `${spot.name} has closed.`);
    if (now > spot.closesAt) {
      return reject("auction_closed", `Bidding on ${spot.name} has finished.`);
    }

    // Stripe will not process a charge below about fifty cents, so anything
    // under that would be taken here and refused at checkout.
    if (!Number.isInteger(amountCents) || amountCents < MIN_BID_CENTS) {
      return reject("amount_invalid", `A bid has to be at least ${formatMoney(MIN_BID_CENTS)}.`);
    }

    if (!getBidderById(bidderId)) {
      return reject("bidder_unknown", "That bidder no longer exists. Sign in again.");
    }

    // No ceiling and no minimum beyond the one above. A bid that does not clear
    // the price to beat is accepted as support and never wins the panel.
    const paid = getPaidBidsForSpot(spot.id);
    const holder = holderOf(spot, paid);
    const target = priceToBeat(spot, paid);

    // Raising your own price is allowed and costs the same step as taking it
    // off somebody else would.
    if (holder && holder.bidderId === bidderId && amountCents < target) {
      return reject(
        "already_holding",
        `You already hold ${spot.name} at ${formatMoney(holder.amountCents)}. ` +
          `Bid ${formatMoney(target)} or more to raise your own price.`,
      );
    }

    const bid = insertBid({
      spotId: spot.id,
      bidderId,
      amountCents,
      status: "pending_payment",
      createdAt: now,
      // Judged here, against the price to beat as it stands right now, and
      // never revisited. Settlement only ranks bids that cleared it.
      contends: amountCents >= target,
    });

    return { ok: true, bid, spot };
  });
}

/* ------------------------------------------------------------------ *
 * Settlement
 * ------------------------------------------------------------------ */

export interface SettleBidInput {
  bidId: string;
  /** Absent in demo mode, where a bid settles without money changing hands. */
  paymentIntentId?: string | null;
  now: number;
}

/** A bid that has already taken money; settling it again must change nothing. */
const SETTLED_STATUSES: readonly Bid["status"][] = ["paid", "outbid", "refunded", "won"];

/** Ids of bids beaten but not yet refunded, best-first within a spot. */
function unrefundedOutbidIds(spotId: string | null): string[] {
  if (spotId === null) {
    return db
      .prepare<unknown[], { id: string }>(
        `SELECT id FROM bids WHERE status = 'outbid' AND stripe_refund_id IS NULL
         ORDER BY created_at ASC`,
      )
      .all()
      .map((row) => row.id);
  }
  return db
    .prepare<unknown[], { id: string }>(
      `SELECT id FROM bids WHERE status = 'outbid' AND stripe_refund_id IS NULL AND spot_id = ?
       ORDER BY amount_cents DESC, sequence ASC`,
    )
    .all(spotId)
    .map((row) => row.id);
}

/**
 * Record that Stripe confirmed payment for a bid, and re-rank the spot.
 *
 * Stripe redelivers webhooks for hours, after a 500, and sometimes out of
 * order, so this is called more than once for the same bid as a matter of
 * routine, not as an error case.
 */
export function settleBid(input: SettleBidInput): SettlementResult {
  const { bidId, paymentIntentId = null, now } = input;

  return transaction(() => {
    const existing = getBidById(bidId);
    if (!existing) throw new AuctionError("bid_unknown", `No bid ${bidId}.`);

    const spot = getSpotById(existing.spotId);
    if (!spot) throw new AuctionError("spot_missing", `Bid ${bidId} points at no spot.`);

    if (SETTLED_STATUSES.includes(existing.status)) {
      return replaySettlement(existing, spot);
    }

    // `expired` and `failed` are also settled here on purpose: if Stripe says the
    // money arrived, our earlier guess that it never would was simply wrong.
    const patch: Partial<Bid> = { status: "paid", paidAt: existing.paidAt ?? now };
    if (paymentIntentId !== null && existing.stripePaymentIntentId !== paymentIntentId) {
      patch.stripePaymentIntentId = paymentIntentId;
    }
    const bid = updateBid(existing.id, patch);
    if (!bid) throw new AuctionError("write_failed", `Bid ${bidId} vanished mid-settlement.`);

    // A payment confirmed after the clock stopped cannot win the spot: the
    // winner was decided from the bids that had settled by then. Marking it
    // outbid here is what makes the API layer refund it.
    if (spot.status === "closed") {
      updateBid(bid.id, { status: "outbid" });
      return { bidId: bid.id, spotKey: spot.key, becameHolder: false, displacedBidId: null, extendedClosesAt: null };
    }

    // Support bids are deliberately absent from this ordering. They were never
    // in contention, so they are not "beaten" by anything and must not be swept
    // into `outbid`, which is the status the close job reads as owing money.
    const order = contendersOf(spot, getPaidBidsForSpot(spot.id));
    const top = order[0] ?? null;
    const becameHolder = top !== null && top.id === bid.id;

    // Everything below the top contender is beaten. That is normally the one
    // previous holder, but writing it as a sweep means a bid settling behind a
    // higher one (a race, or a webhook arriving late) demotes *itself* too.
    for (const beaten of order.slice(1)) {
      updateBid(beaten.id, { status: "outbid" });
    }
    const displacedBidId = becameHolder ? (order[1]?.id ?? null) : null;

    // A spot only counts as held once something is actually holding it. A
    // support bid landing on an untouched spot leaves it open.
    const spotPatch: Partial<Spot> = top === null ? {} : { status: "held" };
    let extendedClosesAt: number | null = null;
    const inWindow = now < spot.closesAt && spot.closesAt - now <= AUCTION.snipeWindowMs;
    if (inWindow && spot.extensionCount < AUCTION.maxExtensions) {
      // From NOW, not from the old close: extending the deadline would compound
      // a burst of bids into hours of extra auction.
      extendedClosesAt = now + AUCTION.extensionMs;
      spotPatch.closesAt = extendedClosesAt;
      spotPatch.extensionCount = spot.extensionCount + 1;
    }
    updateSpot(spot.id, spotPatch);

    return { bidId: bid.id, spotKey: spot.key, becameHolder, displacedBidId, extendedClosesAt };
  });
}

/**
 * The answer for a redelivered webhook: current truth, no writes.
 *
 * `displacedBidId` is reconstructed as the beaten bid still awaiting its money
 * back: the previous holder held the highest amount of anything now outbid, so
 * it ranks first. Once that refund lands the field goes null, which is what
 * stops a redelivery days later from refunding the same card twice.
 */
function replaySettlement(bid: Bid, spot: Spot): SettlementResult {
  const top = holderOf(spot, getPaidBidsForSpot(spot.id));
  const becameHolder = top !== null && top.id === bid.id;
  return {
    bidId: bid.id,
    spotKey: spot.key,
    becameHolder,
    displacedBidId: becameHolder ? (unrefundedOutbidIds(spot.id)[0] ?? null) : null,
    extendedClosesAt: null,
  };
}

/* ------------------------------------------------------------------ *
 * Other transitions
 * ------------------------------------------------------------------ */

/** Confirm the money went back to a beaten bidder. */
export function markRefunded(bidId: string, refundId: string, now: number): Bid | null {
  return transaction(() => {
    const bid = getBidById(bidId);
    if (!bid) return null;
    if (bid.status === "refunded") return bid;
    if (bid.status !== "outbid") {
      throw new AuctionError(
        "not_refundable",
        `Bid ${bidId} is ${bid.status}; only an outbid bid is owed a refund.`,
      );
    }
    return updateBid(bid.id, { status: "refunded", stripeRefundId: refundId, refundedAt: now });
  });
}

/**
 * Abandon a checkout that was never completed.
 *
 * Takes `now` for symmetry with the other transitions; a bid has no expiry
 * column to write it to.
 */
export function expireBid(bidId: string, now: number): Bid | null {
  void now;
  return transaction(() => {
    const bid = getBidById(bidId);
    if (!bid) return null;
    if (bid.status === "expired") return bid;
    if (bid.status !== "pending_payment") {
      throw new AuctionError(
        "not_expirable",
        `Bid ${bidId} is ${bid.status}; a bid that took money cannot expire.`,
      );
    }
    return updateBid(bid.id, { status: "expired" });
  });
}

/* ------------------------------------------------------------------ *
 * The board
 * ------------------------------------------------------------------ */

/**
 * A spot with no survey and no override, which is a corrupt row rather than a
 * normal state: a console-created spot always writes its own box. Drawn small
 * and out of the way so it can be found and fixed instead of covering the car.
 */
const ORPHAN_BOX = { x: 1, y: 1, w: 6, h: 6, difficulty: "mild" } as const;

/**
 * The definition a spot is drawn and priced from.
 *
 * Three sources, in order: what the admin console wrote onto the row, the
 * shipped survey in src/config/car.ts, and a small default box. The survey is
 * still the default for every spot that came from it, so a bad edit is one
 * reset away from the original measurement; but a spot the console created has
 * no survey at all, which is why the row has to be able to carry a whole
 * definition on its own.
 *
 * Text always comes from the row, because renaming a spot is a database edit.
 */
export function definitionOf(spot: Spot): SpotDefinition {
  const shipped = SPOTS.find((candidate) => candidate.key === spot.key) ?? null;
  const base = shipped ?? { key: spot.key, ...ORPHAN_BOX };

  // A half-written override (three columns set, one null) is not a box, so it
  // falls back rather than drawing the spot at x = 0.
  const complete = spot.x !== null && spot.y !== null && spot.w !== null && spot.h !== null;

  return {
    ...base,
    key: spot.key,
    name: spot.name,
    panel: spot.panel,
    blurb: spot.blurb,
    x: complete ? spot.x! : base.x,
    y: complete ? spot.y! : base.y,
    w: complete ? spot.w! : base.w,
    h: complete ? spot.h! : base.h,
    shape: spot.shape ?? shipped?.shape,
    difficulty: spot.difficulty ?? base.difficulty,
  };
}

function viewOf(spot: Spot, now: number): SpotView {
  const geometry = definitionOf(spot);
  // Centimetres follow the box on screen, so a resized spot reports the size it
  // would really be cut at. The floor price does not: it was quoted when the
  // spot opened and bidders have already committed money against it.
  const measured = metricsFor(geometry);

  const paid = getPaidBidsForSpot(spot.id);
  // The holder, not merely the biggest number: a support bid under the listed
  // price never puts a logo on the car.
  const top = holderOf(spot, paid);
  const holderBidder = top ? getBidderById(top.bidderId) : null;
  const artwork = top ? getArtworkByBidId(top.id) : null;
  const approved = artwork !== null && artwork.reviewStatus === "approved";

  return {
    key: spot.key,
    name: spot.name,
    panel: spot.panel,
    blurb: spot.blurb,
    x: geometry.x,
    y: geometry.y,
    w: geometry.w,
    h: geometry.h,
    shape: geometry.shape ?? "rect",
    widthCm: measured.widthCm,
    heightCm: measured.heightCm,

    floorPriceCents: spot.floorPriceCents,
    currentPriceCents: priceOf(spot, paid),
    priceToBeatCents: priceToBeat(spot, paid),
    bidCount: countSettledBidsForSpot(spot.id),
    status: spot.status,
    closesAt: spot.closesAt,
    // True only when a bid placed right now would actually move the clock.
    inExtensionWindow:
      spot.status !== "closed" &&
      now < spot.closesAt &&
      spot.closesAt - now <= AUCTION.snipeWindowMs &&
      spot.extensionCount < AUCTION.maxExtensions,

    holder:
      top && holderBidder
        ? {
            displayName: holderBidder.displayName,
            link: holderBidder.link,
            since: top.paidAt ?? top.createdAt,
            logoUrl: approved && artwork ? `/api/artwork/${artwork.id}/file` : null,
            artworkPending: artwork !== null && !approved,
          }
        : null,
  };
}

/** Everything the board renders from, in one read. */
export function getAuctionState(now: number): AuctionState {
  // The table is the list of spots, not the config: the admin console can add
  // and delete them, so a spot that exists only in the database still has to
  // reach the board, and one deleted from it has to leave.
  const spots = listSpots().map((spot) => viewOf(spot, now));

  const openCloses = spots.filter((s) => s.status !== "closed" && now < s.closesAt);
  const allClosed = openCloses.length === 0;
  const closesAt = allClosed
    ? spots.reduce((latest, s) => Math.max(latest, s.closesAt), now)
    : openCloses.reduce((earliest, s) => Math.min(earliest, s.closesAt), Number.POSITIVE_INFINITY);

  // Money taken so far. There is no target it is measured against: the auction
  // ends on its clock, not on a number being reached.
  const totalRaisedCents = getTotalRaisedCents();

  return {
    spots,
    totalRaisedCents,
    spotsTaken: spots.filter((s) => s.holder !== null).length,
    spotsTotal: spots.length,
    closesAt,
    serverNow: now,
    allClosed,
  };
}

/**
 * The public roll: every bid that ever took money, biggest first.
 *
 * This is not the spot board. A spot shows who is winning it now; the roll
 * shows everyone who has ever paid, including the bidders who were displaced,
 * because their money was not returned to them.
 */
export function getBidRoll(): RollEntry[] {
  return listPaidBids().map((row) => ({
    bidId: row.bid_id,
    displayName: row.display_name,
    link: row.link,
    logoUrl: row.artwork_id ? `/api/artwork/${row.artwork_id}/file` : null,
    spotKey: row.spot_key,
    spotName: row.spot_name,
    amountCents: row.amount_cents,
    paidAt: row.paid_at ?? row.created_at,
    // Compared against the spot's actual holder rather than read off the
    // status: support bids stay `paid` for good, and `paid` alone would put a
    // one-euro bid on the car.
    holding: row.holder_bid_id !== null && row.holder_bid_id === row.bid_id,
  }));
}

/* ------------------------------------------------------------------ *
 * Closing
 * ------------------------------------------------------------------ */

/**
 * Stop the clock on every spot whose time is up.
 *
 * Idempotent by construction: a spot already `closed` is skipped, so a second
 * sweep reports nothing and changes nothing. Refunds are not issued here; the
 * ids are handed back for the API layer to pay out through Stripe.
 */
export function closeAuction(now: number): CloseResult {
  return transaction(() => {
    const winners: CloseResult["winners"] = [];
    let closedSpots = 0;

    for (const spot of listSpots()) {
      if (spot.status === "closed" || now < spot.closesAt) continue;

      updateSpot(spot.id, { status: "closed" });
      closedSpots += 1;

      // The holder, not the biggest number: a spot whose only bids were under
      // its listed price closes unsold, and those bidders keep their place on
      // the roll without winning a panel.
      const top = holderOf(spot, getPaidBidsForSpot(spot.id));
      if (!top) continue;

      if (top.status !== "won") updateBid(top.id, { status: "won" });
      winners.push({
        spotKey: spot.key,
        bidId: top.id,
        bidderId: top.bidderId,
        amountCents: top.amountCents,
      });
    }

    return { closedSpots, winners, refundedBidIds: unrefundedOutbidIds(null) };
  });
}
