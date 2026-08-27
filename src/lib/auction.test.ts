import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUCTION, SPOTS, metricsFor } from "@/config/car";
import { BID_STEP_CENTS, MIN_BID_CENTS } from "@/lib/money";
import type { Bid } from "@/lib/types";

/**
 * Every test runs against its own SQLite file.
 *
 * db.ts caches prepared statements per module instance and the handle itself on
 * globalThis, so swapping the file needs BOTH thrown away: a stale statement
 * bound to a closed handle is the failure mode this dance avoids.
 */
const HANDLE = Symbol.for("datsun-100a-auction.db");
type GlobalWithHandle = typeof globalThis & { [HANDLE]?: { open: boolean; close(): void } };

let auction: typeof import("@/lib/auction");
let store: typeof import("@/lib/db");
let dir: string;

function dropHandle(): void {
  const g = globalThis as GlobalWithHandle;
  const handle = g[HANDLE];
  if (handle?.open) handle.close();
  delete g[HANDLE];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "datsun-auction-"));
  process.env.AUCTION_DB_PATH = join(dir, "auction.db");
  dropHandle();
  vi.resetModules();
  store = await import("@/lib/db");
  auction = await import("@/lib/auction");
});

afterEach(() => {
  dropHandle();
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const T0 = 1_760_000_000_000;
const HOUR = 60 * 60 * 1000;
const FLOOR = 10_000; // €100, increment is the €10 floor, so minimum next is €110

function seedSpot(key: string, floorPriceCents = FLOOR, closesAt = T0 + HOUR) {
  return store.insertSpot({
    key,
    name: key,
    panel: key,
    blurb: key,
    floorPriceCents,
    widthCm: 40,
    heightCm: 20,
    closesAt,
  });
}

/**
 * An amount that beats `cents`.
 *
 * There is no increment ladder any more, so a single cent would do; this is
 * just a readable stand-in for "more than that" in tests that only care that
 * one bid outranks another.
 */
function beats(cents: number): number {
  return cents + 1000;
}

function seedBidder(name: string) {
  return store.insertBidder({ email: `${name}@example.com`, displayName: name });
}

function place(spotKey: string, bidderId: string, amountCents: number, now = T0) {
  const outcome = auction.startBid({ spotKey, bidderId, amountCents, now });
  if (!outcome.ok) throw new Error(`unexpected rejection: ${outcome.reason}`);
  return outcome.bid;
}

function settle(bidId: string, now = T0) {
  return auction.settleBid({ bidId, paymentIntentId: `pi_${bidId}`, now });
}

function placeAndSettle(spotKey: string, bidderId: string, amountCents: number, now = T0) {
  const bid = place(spotKey, bidderId, amountCents, now);
  return { bid, result: settle(bid.id, now) };
}

function fakeBid(over: Partial<Bid> & Pick<Bid, "amountCents" | "sequence">): Bid {
  return {
    id: `bid_${over.sequence}`,
    spotId: "spot_1",
    bidderId: "bdr_1",
    status: "paid",
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    stripeRefundId: null,
    createdAt: T0,
    paidAt: T0,
    refundedAt: null,
    // Contending by default: most tests are about ranking bids that did clear
    // the step, and the ones about support say so explicitly.
    contends: true,
    ...over,
  };
}

const SPOT_SHAPE = {
  id: "spot_1",
  key: "door-main",
  name: "Door panel",
  panel: "Driver's door",
  blurb: "",
  floorPriceCents: FLOOR,
  widthCm: 40,
  heightCm: 20,
  // No geometry override: this fixture uses the shipped survey, like a spot
  // nobody has dragged in the admin console.
  x: null,
  y: null,
  w: null,
  h: null,
  shape: null,
  difficulty: null,
  status: "open" as const,
  closesAt: T0 + HOUR,
  extensionCount: 0,
  createdAt: T0,
};

/* ------------------------------------------------------------------ *
 * Pure ranking
 * ------------------------------------------------------------------ */

describe("topBidOf", () => {
  it("ignores bids that never took money", () => {
    const bids = [
      fakeBid({ amountCents: 90_000, sequence: 1, status: "pending_payment" }),
      fakeBid({ amountCents: 80_000, sequence: 2, status: "outbid" }),
      fakeBid({ amountCents: 70_000, sequence: 3, status: "refunded" }),
      fakeBid({ amountCents: 60_000, sequence: 4, status: "expired" }),
      fakeBid({ amountCents: 50_000, sequence: 5, status: "failed" }),
      fakeBid({ amountCents: 12_000, sequence: 6, status: "paid" }),
    ];
    expect(auction.topBidOf(bids)?.amountCents).toBe(12_000);
  });

  it("counts a won bid as live", () => {
    const bids = [fakeBid({ amountCents: 30_000, sequence: 1, status: "won" })];
    expect(auction.topBidOf(bids)?.id).toBe("bid_1");
  });

  it("breaks ties on the earlier sequence, whatever order the rows arrive in", () => {
    const later = fakeBid({ amountCents: 20_000, sequence: 9 });
    const earlier = fakeBid({ amountCents: 20_000, sequence: 2 });
    expect(auction.topBidOf([later, earlier])?.sequence).toBe(2);
    expect(auction.topBidOf([earlier, later])?.sequence).toBe(2);
  });

  it("is null when nothing has settled", () => {
    expect(auction.topBidOf([])).toBeNull();
    expect(auction.topBidOf([fakeBid({ amountCents: 99_000, sequence: 1, status: "pending_payment" })])).toBeNull();
  });
});

describe("priceOf / contendersOf / holderOf", () => {
  it("stands at the listed price until something contends", () => {
    expect(auction.priceOf(SPOT_SHAPE, [])).toBe(FLOOR);
    expect(auction.holderOf(SPOT_SHAPE, [])).toBeNull();
  });

  it("takes the price of the highest contender, to the cent", () => {
    const bids = [fakeBid({ amountCents: FLOOR + 1, sequence: 1 })];
    expect(auction.priceOf(SPOT_SHAPE, bids)).toBe(FLOOR + 1);
  });

  it("does not let a bid under the listed price hold or price the spot", () => {
    // Support is what the bid WAS, not what its number is: marked at bid time.
    const support = [fakeBid({ amountCents: FLOOR - 1, sequence: 1, contends: false })];
    expect(auction.contendersOf(SPOT_SHAPE, support)).toHaveLength(0);
    expect(auction.holderOf(SPOT_SHAPE, support)).toBeNull();
    // Still the listed price: support money does not move it.
    expect(auction.priceOf(SPOT_SHAPE, support)).toBe(FLOOR);
    // It is the biggest number on the spot, and still not the holder.
    expect(auction.topBidOf(support)?.amountCents).toBe(FLOOR - 1);
  });

  it("ignores support when a contender exists, whatever the order", () => {
    const bids = [
      fakeBid({ amountCents: FLOOR - 1, sequence: 1, contends: false }),
      fakeBid({ amountCents: FLOOR, sequence: 2 }),
    ];
    expect(auction.holderOf(SPOT_SHAPE, bids)?.amountCents).toBe(FLOOR);
  });
});

/* ------------------------------------------------------------------ *
 * startBid
 * ------------------------------------------------------------------ */

describe("startBid", () => {
  it("takes any amount from the minimum bid upward", () => {
    seedSpot("door-main");
    const bidder = seedBidder("Ana");

    const tooSmall = auction.startBid({
      spotKey: "door-main",
      bidderId: bidder.id,
      amountCents: MIN_BID_CENTS - 1,
      now: T0,
    });
    expect(tooSmall.ok).toBe(false);
    if (tooSmall.ok) throw new Error("unreachable");
    expect(tooSmall.reason).toBe("amount_invalid");

    // Well under the listed price, and accepted: it becomes support.
    const support = auction.startBid({
      spotKey: "door-main",
      bidderId: bidder.id,
      amountCents: MIN_BID_CENTS,
      now: T0,
    });
    expect(support.ok).toBe(true);
    if (!support.ok) throw new Error("unreachable");
    expect(support.bid.amountCents).toBe(MIN_BID_CENTS);
  });

  it("asks a full step to take a held spot, and the listed price for an empty one", () => {
    const spot = seedSpot("door-main");
    const ana = seedBidder("Ana");

    expect(auction.priceToBeat(spot, [])).toBe(FLOOR);

    placeAndSettle("door-main", ana.id, FLOOR);
    const paid = store.getPaidBidsForSpot(spot.id);
    expect(auction.priceToBeat(spot, paid)).toBe(FLOOR + BID_STEP_CENTS);
  });

  it("takes a bid under the step, and does not give it the panel", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    placeAndSettle("door-main", ana.id, FLOOR);

    // A bigger number than the holder, and still short of the step.
    placeAndSettle("door-main", bo.id, FLOOR + BID_STEP_CENTS - 1);

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(view?.holder?.displayName).toBe("Ana");
    expect(view?.currentPriceCents).toBe(FLOOR);
    // Both were charged, so both are money the car took.
    expect(auction.getAuctionState(T0).totalRaisedCents).toBe(FLOOR * 2 + BID_STEP_CENTS - 1);
  });

  it("hands the panel over at exactly one step more", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    placeAndSettle("door-main", ana.id, FLOOR);
    placeAndSettle("door-main", bo.id, FLOOR + BID_STEP_CENTS);

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(view?.holder?.displayName).toBe("Bo");
    expect(view?.currentPriceCents).toBe(FLOOR + BID_STEP_CENTS);
    expect(view?.priceToBeatCents).toBe(FLOOR + 2 * BID_STEP_CENTS);
  });

  it("makes the holder pay a full step to raise their own price", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    placeAndSettle("door-main", ana.id, FLOOR);

    const short = auction.startBid({
      spotKey: "door-main",
      bidderId: ana.id,
      amountCents: FLOOR + BID_STEP_CENTS - 1,
      now: T0,
    });
    expect(short.ok === false && short.reason).toBe("already_holding");

    expect(
      auction.startBid({
        spotKey: "door-main",
        bidderId: ana.id,
        amountCents: FLOOR + BID_STEP_CENTS,
        now: T0,
      }).ok,
    ).toBe(true);
  });

  it("keeps support money off the car and off the price", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    placeAndSettle("door-main", ana.id, FLOOR - 1);

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(view?.holder).toBeNull();
    expect(view?.currentPriceCents).toBe(FLOOR);
    expect(view?.status).toBe("open");
  });

  it("still counts support money as raised", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    placeAndSettle("door-main", ana.id, FLOOR - 1);

    expect(auction.getAuctionState(T0).totalRaisedCents).toBe(FLOOR - 1);
  });

  it("closes a spot unsold when only support was paid", () => {
    seedSpot("door-main", FLOOR, T0 + HOUR);
    const ana = seedBidder("Ana");
    placeAndSettle("door-main", ana.id, FLOOR - 1);

    const result = auction.closeAuction(T0 + 2 * HOUR);
    expect(result.closedSpots).toBe(1);
    expect(result.winners).toHaveLength(0);
  });

  it("leaves price and holder untouched while a bid is unpaid", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    place("door-main", ana.id, 500_000);

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(view?.currentPriceCents).toBe(FLOOR);
    expect(view?.bidCount).toBe(0);
    expect(view?.holder).toBeNull();
    expect(view?.status).toBe("open");

    // and the next bidder may still take the spot at the floor
    const bo = seedBidder("Bo");
    expect(
      auction.startBid({ spotKey: "door-main", bidderId: bo.id, amountCents: FLOOR, now: T0 }).ok,
    ).toBe(true);
  });

  describe("rejections", () => {
    it("spot_unknown", () => {
      const bidder = seedBidder("Ana");
      const out = auction.startBid({
        spotKey: "no-such-panel",
        bidderId: bidder.id,
        amountCents: FLOOR,
        now: T0,
      });
      expect(out.ok === false && out.reason).toBe("spot_unknown");
    });

    it("spot_closed", () => {
      const spot = seedSpot("door-main");
      store.updateSpot(spot.id, { status: "closed" });
      const bidder = seedBidder("Ana");
      const out = auction.startBid({
        spotKey: "door-main",
        bidderId: bidder.id,
        amountCents: FLOOR,
        now: T0,
      });
      expect(out.ok === false && out.reason).toBe("spot_closed");
    });

    it("auction_closed", () => {
      seedSpot("door-main", FLOOR, T0 + 1000);
      const bidder = seedBidder("Ana");
      const out = auction.startBid({
        spotKey: "door-main",
        bidderId: bidder.id,
        amountCents: FLOOR,
        now: T0 + 1001,
      });
      expect(out.ok === false && out.reason).toBe("auction_closed");
    });

    it("amount_invalid for zero, negative and fractional cents", () => {
      seedSpot("door-main");
      const bidder = seedBidder("Ana");
      for (const amountCents of [0, -1, -FLOOR, FLOOR + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const out = auction.startBid({
          spotKey: "door-main",
          bidderId: bidder.id,
          amountCents,
          now: T0,
        });
        expect(out.ok === false && out.reason).toBe("amount_invalid");
      }
    });

    it("bidder_unknown", () => {
      seedSpot("door-main");
      const out = auction.startBid({
        spotKey: "door-main",
        bidderId: "bdr_ghost",
        amountCents: FLOOR,
        now: T0,
      });
      expect(out.ok === false && out.reason).toBe("bidder_unknown");
    });

    it("already_holding: the holder cannot bid at or under their own price", () => {
      seedSpot("door-main");
      const ana = seedBidder("Ana");
      placeAndSettle("door-main", ana.id, FLOOR);

      const out = auction.startBid({
        spotKey: "door-main",
        bidderId: ana.id,
        amountCents: FLOOR,
        now: T0,
      });
      expect(out.ok === false && out.reason).toBe("already_holding");
    });

    it("lets the holder raise their own price", () => {
      seedSpot("door-main");
      const ana = seedBidder("Ana");
      placeAndSettle("door-main", ana.id, FLOOR);

      // The dialog has always offered this; the engine used to refuse it.
      const out = auction.startBid({
        spotKey: "door-main",
        bidderId: ana.id,
        amountCents: beats(FLOOR),
        now: T0,
      });
      expect(out.ok).toBe(true);
    });

    it("lets the outbid bidder come back", () => {
      seedSpot("door-main");
      const ana = seedBidder("Ana");
      const bo = seedBidder("Bo");
      placeAndSettle("door-main", ana.id, FLOOR);
      placeAndSettle("door-main", bo.id, beats(FLOOR));

      const out = auction.startBid({
        spotKey: "door-main",
        bidderId: ana.id,
        amountCents: beats(beats(FLOOR)),
        now: T0,
      });
      expect(out.ok).toBe(true);
    });

    it("writes nothing when it rejects", () => {
      const spot = seedSpot("door-main");
      const bidder = seedBidder("Ana");
      auction.startBid({ spotKey: "door-main", bidderId: bidder.id, amountCents: 1, now: T0 });
      expect(store.listBidsForSpot(spot.id)).toHaveLength(0);
    });
  });
});

/* ------------------------------------------------------------------ *
 * settleBid
 * ------------------------------------------------------------------ */

describe("settleBid", () => {
  it("hands the spot to the payer and marks the previous holder outbid", () => {
    const spot = seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");

    const first = placeAndSettle("door-main", ana.id, FLOOR);
    expect(first.result.becameHolder).toBe(true);
    expect(first.result.displacedBidId).toBeNull();

    const second = placeAndSettle("door-main", bo.id, beats(FLOOR));
    expect(second.result.becameHolder).toBe(true);
    expect(second.result.displacedBidId).toBe(first.bid.id);

    expect(store.getBidById(first.bid.id)?.status).toBe("outbid");
    expect(store.getBidById(second.bid.id)?.status).toBe("paid");
    expect(store.getTopPaidBid(spot.id)?.id).toBe(second.bid.id);
    expect(store.getSpotById(spot.id)?.status).toBe("held");

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(view?.currentPriceCents).toBe(beats(FLOOR));
    expect(view?.holder?.displayName).toBe("Bo");
    // Cumulative: the displaced bid was real money and still counts.
    expect(view?.bidCount).toBe(2);
  });

  it("records the payment intent and the paid timestamp", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bid = place("door-main", ana.id, FLOOR);
    auction.settleBid({ bidId: bid.id, paymentIntentId: "pi_live_1", now: T0 + 5 });

    const settled = store.getBidById(bid.id);
    expect(settled?.stripePaymentIntentId).toBe("pi_live_1");
    expect(settled?.paidAt).toBe(T0 + 5);
  });

  it("settles in demo mode without a payment intent", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bid = place("door-main", ana.id, FLOOR);
    const result = auction.settleBid({ bidId: bid.id, now: T0 });

    expect(result.becameHolder).toBe(true);
    expect(store.getBidById(bid.id)?.stripePaymentIntentId).toBeNull();
  });

  it("leaves a lower bid outbid when it settles AFTER a higher one", () => {
    const spot = seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");

    // both checkouts open while the spot is still at its floor
    const low = place("door-main", ana.id, FLOOR);
    const high = place("door-main", bo.id, 50_000);

    const highResult = settle(high.id);
    expect(highResult.becameHolder).toBe(true);

    const lowResult = settle(low.id, T0 + 1);
    expect(lowResult.becameHolder).toBe(false);
    expect(lowResult.displacedBidId).toBeNull();

    expect(store.getBidById(low.id)?.status).toBe("outbid");
    expect(store.getBidById(low.id)?.paidAt).toBe(T0 + 1); // the money did arrive
    expect(store.getBidById(high.id)?.status).toBe("paid");
    expect(store.getTopPaidBid(spot.id)?.id).toBe(high.id);
    expect(auction.getAuctionState(T0).spots.find((s) => s.key === "door-main")?.holder?.displayName).toBe("Bo");
  });

  it("is idempotent when Stripe redelivers the webhook", () => {
    const spot = seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    const first = placeAndSettle("door-main", ana.id, FLOOR);
    const second = placeAndSettle("door-main", bo.id, beats(FLOOR));

    const replay = auction.settleBid({ bidId: second.bid.id, paymentIntentId: `pi_${second.bid.id}`, now: T0 + 60_000 });
    expect(replay).toEqual(second.result);

    // nothing moved: no second displacement, no new price, no extra extension
    expect(store.getBidById(first.bid.id)?.status).toBe("outbid");
    expect(store.getBidById(second.bid.id)?.paidAt).toBe(T0);
    expect(store.getSpotById(spot.id)?.extensionCount).toBe(0);
    expect(store.getSpotById(spot.id)?.closesAt).toBe(T0 + HOUR);
    expect(auction.getAuctionState(T0).spots.find((s) => s.key === "door-main")?.bidCount).toBe(2);
  });

  it("stops reporting a displaced bid once its refund has landed", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    const first = placeAndSettle("door-main", ana.id, FLOOR);
    const second = placeAndSettle("door-main", bo.id, beats(FLOOR));

    auction.markRefunded(first.bid.id, "re_1", T0 + 10);
    const replay = settle(second.bid.id, T0 + 20);
    expect(replay.becameHolder).toBe(true);
    expect(replay.displacedBidId).toBeNull();
  });

  it("does not resurrect a bid that was already outbid", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    const first = placeAndSettle("door-main", ana.id, FLOOR);
    placeAndSettle("door-main", bo.id, beats(FLOOR));

    const replay = settle(first.bid.id, T0 + 30);
    expect(replay.becameHolder).toBe(false);
    expect(store.getBidById(first.bid.id)?.status).toBe("outbid");
  });

  it("equal amounts: the earlier sequence keeps the spot", () => {
    const spot = seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");

    const early = place("door-main", ana.id, FLOOR);
    const late = place("door-main", bo.id, FLOOR);
    expect(late.sequence).toBeGreaterThan(early.sequence);

    settle(early.id);
    const lateResult = settle(late.id, T0 + 1);

    expect(lateResult.becameHolder).toBe(false);
    expect(store.getTopPaidBid(spot.id)?.id).toBe(early.id);
    expect(store.getBidById(late.id)?.status).toBe("outbid");
  });

  it("refuses to settle an unknown bid", () => {
    expect(() => auction.settleBid({ bidId: "bid_ghost", now: T0 })).toThrow(auction.AuctionError);
  });

  it("refunds rather than crowns a payment that lands after the spot closed", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + HOUR);
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    const winner = placeAndSettle("door-main", ana.id, FLOOR);
    const late = place("door-main", bo.id, 500_000);

    auction.closeAuction(T0 + 2 * HOUR);
    const result = settle(late.id, T0 + 2 * HOUR + 1000);

    expect(result.becameHolder).toBe(false);
    expect(store.getBidById(late.id)?.status).toBe("outbid");
    expect(store.getBidById(winner.bid.id)?.status).toBe("won");
    expect(store.getSpotById(spot.id)?.status).toBe("closed");
  });
});

/* ------------------------------------------------------------------ *
 * Anti-snipe
 * ------------------------------------------------------------------ */

describe("anti-snipe", () => {
  it("extends from now, not from the old close", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + 60_000); // inside the 5-minute window
    const ana = seedBidder("Ana");
    const { result } = placeAndSettle("door-main", ana.id, FLOOR);

    expect(result.extendedClosesAt).toBe(T0 + AUCTION.extensionMs);
    const after = store.getSpotById(spot.id);
    expect(after?.closesAt).toBe(T0 + AUCTION.extensionMs);
    expect(after?.closesAt).not.toBe(T0 + 60_000 + AUCTION.extensionMs);
    expect(after?.extensionCount).toBe(1);
  });

  it("does not extend a bid placed well before the close", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + HOUR);
    const ana = seedBidder("Ana");
    const { result } = placeAndSettle("door-main", ana.id, FLOOR);

    expect(result.extendedClosesAt).toBeNull();
    expect(store.getSpotById(spot.id)?.closesAt).toBe(T0 + HOUR);
    expect(store.getSpotById(spot.id)?.extensionCount).toBe(0);
  });

  it("extends one spot without touching its neighbours", () => {
    const door = seedSpot("door-main", FLOOR, T0 + 60_000);
    const roof = seedSpot("roof", FLOOR, T0 + 60_000);
    const ana = seedBidder("Ana");
    placeAndSettle("door-main", ana.id, FLOOR);

    expect(store.getSpotById(door.id)?.closesAt).toBe(T0 + AUCTION.extensionMs);
    expect(store.getSpotById(roof.id)?.closesAt).toBe(T0 + 60_000);
    expect(store.getSpotById(roof.id)?.extensionCount).toBe(0);
  });

  it("stops extending at maxExtensions", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + 60_000);
    store.updateSpot(spot.id, { extensionCount: AUCTION.maxExtensions });
    const ana = seedBidder("Ana");
    const { result } = placeAndSettle("door-main", ana.id, FLOOR);

    expect(result.extendedClosesAt).toBeNull();
    expect(store.getSpotById(spot.id)?.closesAt).toBe(T0 + 60_000);
    expect(store.getSpotById(spot.id)?.extensionCount).toBe(AUCTION.maxExtensions);
  });

  it("does not compound across a flurry of settlements", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + 60_000);
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    placeAndSettle("door-main", ana.id, FLOOR, T0);
    placeAndSettle("door-main", bo.id, beats(FLOOR), T0 + 1000);

    // each extension restarts the same window from the latest bid; two bids a
    // second apart buy one window, not two
    expect(store.getSpotById(spot.id)?.closesAt).toBe(T0 + 1000 + AUCTION.extensionMs);
    expect(store.getSpotById(spot.id)?.closesAt).not.toBe(T0 + 60_000 + 2 * AUCTION.extensionMs);
    expect(store.getSpotById(spot.id)?.extensionCount).toBe(2);
  });
});

/* ------------------------------------------------------------------ *
 * Refunds and expiry
 * ------------------------------------------------------------------ */

describe("markRefunded", () => {
  it("moves an outbid bid to refunded and is idempotent", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    const first = placeAndSettle("door-main", ana.id, FLOOR);
    placeAndSettle("door-main", bo.id, beats(FLOOR));

    const refunded = auction.markRefunded(first.bid.id, "re_1", T0 + 10);
    expect(refunded?.status).toBe("refunded");
    expect(refunded?.stripeRefundId).toBe("re_1");
    expect(refunded?.refundedAt).toBe(T0 + 10);

    expect(auction.markRefunded(first.bid.id, "re_2", T0 + 20)?.stripeRefundId).toBe("re_1");
  });

  it("refuses to refund the bid that is still holding the spot", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const { bid } = placeAndSettle("door-main", ana.id, FLOOR);
    expect(() => auction.markRefunded(bid.id, "re_1", T0)).toThrow(auction.AuctionError);
  });

  it("returns null for an unknown bid", () => {
    expect(auction.markRefunded("bid_ghost", "re_1", T0)).toBeNull();
  });
});

describe("expireBid", () => {
  it("expires an abandoned checkout and is idempotent", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bid = place("door-main", ana.id, FLOOR);

    expect(auction.expireBid(bid.id, T0 + 10)?.status).toBe("expired");
    expect(auction.expireBid(bid.id, T0 + 20)?.status).toBe("expired");
  });

  it("refuses to expire a bid that has been paid", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const { bid } = placeAndSettle("door-main", ana.id, FLOOR);

    expect(() => auction.expireBid(bid.id, T0 + 10)).toThrow(auction.AuctionError);
    expect(store.getBidById(bid.id)?.status).toBe("paid");
  });

  it("still settles a bid whose checkout we had given up on", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bid = place("door-main", ana.id, FLOOR);
    auction.expireBid(bid.id, T0 + 10);

    expect(settle(bid.id, T0 + 20).becameHolder).toBe(true);
    expect(store.getBidById(bid.id)?.status).toBe("paid");
  });
});

/* ------------------------------------------------------------------ *
 * getAuctionState
 * ------------------------------------------------------------------ */

describe("getAuctionState", () => {
  // Keyed off whatever the config actually holds rather than a named spot: the
  // survey is editable from the admin console and exported back over this file,
  // so any particular key may not be there tomorrow.
  it("joins config geometry onto the persisted row", () => {
    const geometry = SPOTS[0];
    seedSpot(geometry.key);
    const view = auction.getAuctionState(T0).spots.find((s) => s.key === geometry.key);
    expect(view?.x).toBe(geometry.x);
    expect(view?.y).toBe(geometry.y);
    expect(view?.w).toBe(geometry.w);
    expect(view?.h).toBe(geometry.h);
    expect(view?.shape).toBe(geometry.shape ?? "rect");
    // Centimetres are measured off the box, not read back from the row: the
    // row's 40 x 20 is a seed fixture, the survey is what the car really is.
    expect(view?.widthCm).toBeCloseTo(metricsFor(geometry).widthCm, 6);
  });

  it("prefers a geometry override written by the admin console", () => {
    const spot = seedSpot("door-main");
    store.updateSpot(spot.id, { x: 10, y: 20, w: 30, h: 12, shape: "ellipse" });

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(view?.x).toBe(10);
    expect(view?.y).toBe(20);
    expect(view?.w).toBe(30);
    expect(view?.h).toBe(12);
    expect(view?.shape).toBe("ellipse");

    const definition = SPOTS.find((s) => s.key === "door-main") ?? SPOTS[0];
    const expected = metricsFor({ ...definition, x: 10, y: 20, w: 30, h: 12, shape: "ellipse" });
    expect(view?.widthCm).toBeCloseTo(expected.widthCm, 6);
    expect(view?.heightCm).toBeCloseTo(expected.heightCm, 6);
  });

  it("falls back to the survey when an override is only half written", () => {
    const spot = seedSpot("door-main");
    // A row that somehow carries x and y but no size must not draw a spot at
    // width zero; the shipped measurement is the floor under every edit.
    store.updateSpot(spot.id, { x: 10, y: 20 });

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    const definition = SPOTS.find((s) => s.key === "door-main");
    expect(view?.x).toBe(definition?.x);
    expect(view?.w).toBe(definition?.w);
  });

  it("does not move a spot's floor price when its box is resized", () => {
    const spot = seedSpot("door-main");
    store.updateSpot(spot.id, { x: 1, y: 1, w: 2, h: 2 });

    const view = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(view?.floorPriceCents).toBe(FLOOR);
    expect(view?.currentPriceCents).toBe(FLOOR);
  });

  it("totals only settled money", () => {
    seedSpot("door-main");
    seedSpot("roof");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    placeAndSettle("door-main", ana.id, 100_000);
    place("roof", bo.id, 25_000); // unpaid, must not count

    const state = auction.getAuctionState(T0);
    expect(state.totalRaisedCents).toBe(100_000);
    expect(state.spotsTaken).toBe(1);
    expect(state.spotsTotal).toBe(2);
    expect(state.serverNow).toBe(T0);
  });

  it("excludes money already owed back to an outbid bidder", () => {
    seedSpot("door-main");
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    placeAndSettle("door-main", ana.id, FLOOR);
    placeAndSettle("door-main", bo.id, beats(FLOOR));

    // the outbid bid leaves LIVE status the moment it is displaced
    expect(auction.getAuctionState(T0).totalRaisedCents).toBe(beats(FLOOR));
  });

  it("shows a logo only once a human approved it", () => {
    const spot = seedSpot("door-main");
    const ana = seedBidder("Ana");
    const { bid } = placeAndSettle("door-main", ana.id, FLOOR);

    const before = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(before?.holder?.artworkPending).toBe(false);
    expect(before?.holder?.logoUrl).toBeNull();
    expect(before?.holder?.since).toBe(T0);

    const artwork = store.insertArtwork({
      bidId: bid.id,
      spotId: spot.id,
      bidderId: ana.id,
      filename: "logo.png",
      mimeType: "image/png",
      byteSize: 1024,
      storedPath: "logo.png",
    });

    const pending = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(pending?.holder?.artworkPending).toBe(true);
    expect(pending?.holder?.logoUrl).toBeNull();

    store.updateArtwork(artwork.id, { reviewStatus: "approved", reviewedAt: T0 });
    const approved = auction.getAuctionState(T0).spots.find((s) => s.key === "door-main");
    expect(approved?.holder?.artworkPending).toBe(false);
    expect(approved?.holder?.logoUrl).toBe(`/api/artwork/${artwork.id}/file`);
  });

  it("headlines the earliest open close, then the latest once all are shut", () => {
    const door = seedSpot("door-main", FLOOR, T0 + HOUR);
    const roof = seedSpot("roof", FLOOR, T0 + 2 * HOUR);

    const open = auction.getAuctionState(T0);
    expect(open.closesAt).toBe(T0 + HOUR);
    expect(open.allClosed).toBe(false);

    store.updateSpot(door.id, { status: "closed" });
    expect(auction.getAuctionState(T0).closesAt).toBe(T0 + 2 * HOUR);

    store.updateSpot(roof.id, { status: "closed" });
    const shut = auction.getAuctionState(T0);
    expect(shut.allClosed).toBe(true);
    expect(shut.closesAt).toBe(T0 + 2 * HOUR);
  });

  it("flags the extension window only while a bid could still move the clock", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + AUCTION.snipeWindowMs - 1);
    expect(auction.getAuctionState(T0).spots[0]?.inExtensionWindow).toBe(true);
    expect(auction.getAuctionState(T0 - HOUR).spots[0]?.inExtensionWindow).toBe(false);

    store.updateSpot(spot.id, { extensionCount: AUCTION.maxExtensions });
    expect(auction.getAuctionState(T0).spots[0]?.inExtensionWindow).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * closeAuction
 * ------------------------------------------------------------------ */

describe("closeAuction", () => {
  it("crowns the standing holder and is idempotent", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + HOUR);
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    const loser = placeAndSettle("door-main", ana.id, FLOOR);
    const winner = placeAndSettle("door-main", bo.id, beats(FLOOR));

    const first = auction.closeAuction(T0 + 2 * HOUR);
    expect(first.closedSpots).toBe(1);
    expect(first.winners).toEqual([
      {
        spotKey: "door-main",
        bidId: winner.bid.id,
        bidderId: bo.id,
        amountCents: beats(FLOOR),
      },
    ]);
    expect(first.refundedBidIds).toEqual([loser.bid.id]);
    expect(store.getBidById(winner.bid.id)?.status).toBe("won");
    expect(store.getSpotById(spot.id)?.status).toBe("closed");

    const second = auction.closeAuction(T0 + 3 * HOUR);
    expect(second.closedSpots).toBe(0);
    expect(second.winners).toEqual([]);
    expect(store.getBidById(winner.bid.id)?.status).toBe("won");
    expect(store.getBidById(loser.bid.id)?.status).toBe("outbid");
  });

  it("closes only the spots whose clock has actually stopped", () => {
    const early = seedSpot("door-main", FLOOR, T0 + HOUR);
    const late = seedSpot("roof", FLOOR, T0 + 4 * HOUR);
    const ana = seedBidder("Ana");
    placeAndSettle("door-main", ana.id, FLOOR);
    placeAndSettle("roof", ana.id, FLOOR);

    const result = auction.closeAuction(T0 + 2 * HOUR);
    expect(result.closedSpots).toBe(1);
    expect(result.winners.map((w) => w.spotKey)).toEqual(["door-main"]);
    expect(store.getSpotById(early.id)?.status).toBe("closed");
    expect(store.getSpotById(late.id)?.status).toBe("held");
  });

  it("closes an unsold spot with no winner, still at its floor", () => {
    const spot = seedSpot("door-main", FLOOR, T0 + HOUR);
    const result = auction.closeAuction(T0 + 2 * HOUR);

    expect(result.closedSpots).toBe(1);
    expect(result.winners).toEqual([]);
    expect(store.getSpotById(spot.id)?.status).toBe("closed");

    const view = auction.getAuctionState(T0 + 2 * HOUR).spots.find((s) => s.key === "door-main");
    expect(view?.currentPriceCents).toBe(FLOOR);
    expect(view?.holder).toBeNull();
    expect(view?.status).toBe("closed");
  });

  it("does not list an already-refunded bid for refund again", () => {
    seedSpot("door-main", FLOOR, T0 + HOUR);
    const ana = seedBidder("Ana");
    const bo = seedBidder("Bo");
    const loser = placeAndSettle("door-main", ana.id, FLOOR);
    placeAndSettle("door-main", bo.id, beats(FLOOR));
    auction.markRefunded(loser.bid.id, "re_1", T0 + 5);

    expect(auction.closeAuction(T0 + 2 * HOUR).refundedBidIds).toEqual([]);
  });

  it("leaves a pending bid alone when the clock stops", () => {
    seedSpot("door-main", FLOOR, T0 + HOUR);
    const ana = seedBidder("Ana");
    const pending = place("door-main", ana.id, FLOOR);

    const result = auction.closeAuction(T0 + 2 * HOUR);
    expect(result.winners).toEqual([]);
    expect(store.getBidById(pending.id)?.status).toBe("pending_payment");
  });
});
