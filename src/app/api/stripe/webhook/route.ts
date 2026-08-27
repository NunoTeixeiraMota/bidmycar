import { NextResponse } from "next/server";

import { AuctionError, expireBid, markRefunded, settleBid } from "@/lib/auction";
import {
  getBidByCheckoutSessionId,
  getBidByPaymentIntentId,
  getBidById,
  updateBid,
} from "@/lib/db";
import { constructWebhookEvent, paymentIntentIdOf, refundPayment, type Stripe } from "@/lib/stripe";
import type { Bid } from "@/lib/types";

/**
 * Stripe's half of the conversation, and the only place a payment becomes a
 * held spot. The browser coming back from Checkout proves nothing: a buyer who
 * closes the tab at the "thanks" screen must still get their panel, so the
 * return page reads state and this route writes it.
 *
 * Everything here is written for repeat delivery. Stripe retries for three days
 * on any non-2xx, replays out of order, and re-sends an event whose response it
 * never saw even though we committed. So each handler either performs its effect
 * or recognises that it already has.
 *
 * The status code is an instruction, not commentary: 2xx and 4xx both retire the
 * event, 5xx asks for it again later. That is why a bid we cannot find is a log
 * line and a 200: it almost certainly belongs to another environment pointed at
 * the same endpoint, and 500ing would open a three-day retry loop over data that
 * will never exist in this database.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What one delivery did. Stripe ignores the body; `stripe listen` prints it. */
interface Outcome {
  action:
    | "settled"
    | "expired"
    | "failed"
    | "refunded"
    | "reconciled"
    | "refund_failed"
    | "ignored";
  bidId?: string;
  detail?: string;
  /** Ask Stripe to deliver again: something transient stopped us finishing. */
  retry?: boolean;
}

const IGNORED = (detail: string): Outcome => ({ action: "ignored", detail });

/** Stripe hands back an id or the expanded object, depending on the event. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * The bid a Checkout session belongs to.
 *
 * Session id first because it is the column with a unique index, then the
 * metadata copy: the webhook can beat POST /api/bids to writing the session id
 * back onto the row, and `metadata.bidId` was set when the session was created.
 */
function bidForSession(session: Stripe.Checkout.Session): Bid | null {
  const bySession = getBidByCheckoutSessionId(session.id);
  if (bySession) return bySession;

  const declared = session.metadata?.bidId ?? session.client_reference_id;
  return declared ? getBidById(declared) : null;
}

/* ------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------ */

type RefundOutcome =
  | { ok: true; refundId: string }
  | { ok: false; message: string; retryable: boolean };

/**
 * Give one beaten bidder their money back.
 *
 * The stored refund id is the idempotency guard that survives a redelivery days
 * later, when the engine can no longer tell that this bid was the one displaced.
 * Stripe's own idempotency key is the second line of defence, not the first.
 */
async function refundBid(bidId: string, now: number): Promise<RefundOutcome> {
  const bid = getBidById(bidId);
  if (!bid) return { ok: false, message: `Bid ${bidId} vanished before its refund.`, retryable: false };
  if (bid.stripeRefundId) return { ok: true, refundId: bid.stripeRefundId };

  const refund = await refundPayment(bid.stripePaymentIntentId);
  if (!refund.ok) return { ok: false, message: refund.message, retryable: refund.retryable };

  try {
    markRefunded(bid.id, refund.refundId, now);
  } catch (err) {
    if (!(err instanceof AuctionError)) throw err;
    // The money is back but the row refused the transition. Retrying cannot fix
    // that, and the refund exists on Stripe either way, so it is reported rather
    // than replayed.
    return { ok: false, message: err.message, retryable: false };
  }
  return { ok: true, refundId: refund.refundId };
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

async function onCheckoutCompleted(
  session: Stripe.Checkout.Session,
  now: number,
): Promise<Outcome> {
  const bid = bidForSession(session);
  if (!bid) {
    console.warn(`[stripe] checkout ${session.id} matches no bid here; ignoring.`);
    return IGNORED("no matching bid");
  }

  // `completed` fires for delayed payment methods before the money lands. Those
  // sessions settle later, on async_payment_succeeded.
  if (session.payment_status === "unpaid") return IGNORED("payment_status is unpaid");

  const result = settleBid({ bidId: bid.id, paymentIntentId: paymentIntentIdOf(session), now });

  // Exactly one bid can be owed money by a settlement: the holder this one
  // displaced, or, when this payment landed behind a higher one, this one.
  const owed = result.displacedBidId ?? (result.becameHolder ? null : result.bidId);
  if (!owed) return { action: "settled", bidId: bid.id };

  const refund = await refundBid(owed, now);
  if (refund.ok) {
    return { action: "settled", bidId: bid.id, detail: `refunded ${owed}` };
  }
  console.error(`[stripe] refund of ${owed} failed: ${refund.message}`);
  // A retryable failure is worth a redelivery: replaying settlement re-derives
  // the same debt from the refund id still being null, so the attempt repeats.
  return { action: "settled", bidId: bid.id, detail: refund.message, retry: refund.retryable };
}

function onCheckoutExpired(session: Stripe.Checkout.Session, now: number): Outcome {
  const bid = bidForSession(session);
  if (!bid) return IGNORED("no matching bid");

  try {
    expireBid(bid.id, now);
    return { action: "expired", bidId: bid.id };
  } catch (err) {
    if (!(err instanceof AuctionError)) throw err;
    // A session that expired after its payment settled: the money wins.
    return IGNORED(err.message);
  }
}

function onPaymentFailed(bid: Bid | null): Outcome {
  if (!bid) return IGNORED("no matching bid");
  if (bid.status !== "pending_payment") return IGNORED(`bid is ${bid.status}`);
  updateBid(bid.id, { status: "failed" });
  return { action: "failed", bidId: bid.id };
}

/**
 * Write a refund Stripe tells us about onto the bid it belongs to.
 *
 * Refunds we issue ourselves are already recorded by `refundBid`; this is what
 * catches the ones we did not: a refund made by hand in the dashboard, and the
 * later `refund.updated` that says one failed after being accepted.
 */
function onRefundEvent(
  paymentIntentId: string | null,
  refundId: string | null,
  refundStatus: string | null,
  metadataBidId: string | undefined,
  now: number,
): Outcome {
  const bid =
    (paymentIntentId ? getBidByPaymentIntentId(paymentIntentId) : null) ??
    (metadataBidId ? getBidById(metadataBidId) : null);

  if (!bid) {
    console.warn(`[stripe] refund ${refundId ?? "?"} matches no bid here; ignoring.`);
    return IGNORED("no matching bid");
  }
  if (!refundId) return IGNORED("event carried no refund id");

  if (refundStatus === "failed" || refundStatus === "canceled") {
    // The money did not actually go back. Returning the bid to `outbid` with no
    // refund id is what puts it back in the close job's retry sweep; the engine
    // has no un-refund transition because nothing else should ever need one.
    if (bid.status === "refunded" && bid.stripeRefundId === refundId) {
      updateBid(bid.id, { status: "outbid", stripeRefundId: null, refundedAt: null });
      console.error(`[stripe] refund ${refundId} for bid ${bid.id} ${refundStatus}; owed again.`);
      return { action: "refund_failed", bidId: bid.id };
    }
    return IGNORED(`refund ${refundStatus}`);
  }

  if (bid.stripeRefundId === refundId) return IGNORED("already reconciled");

  if (bid.status === "outbid" || bid.status === "refunded") {
    markRefunded(bid.id, refundId, now);
    return { action: "refunded", bidId: bid.id };
  }

  // A live bid refunded outside the app. Record it so the ledger is honest, but
  // do not strip the spot from its holder: a human did this and a human should
  // decide what it meant.
  updateBid(bid.id, { stripeRefundId: refundId, refundedAt: bid.refundedAt ?? now });
  console.warn(`[stripe] bid ${bid.id} is ${bid.status} but was refunded (${refundId}).`);
  return { action: "reconciled", bidId: bid.id, detail: `bid is ${bid.status}` };
}

/* ------------------------------------------------------------------ *
 * Route
 * ------------------------------------------------------------------ */

async function dispatch(event: Stripe.Event, now: number): Promise<Outcome> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return onCheckoutCompleted(event.data.object, now);

    case "checkout.session.expired":
      return onCheckoutExpired(event.data.object, now);

    case "checkout.session.async_payment_failed":
      return onPaymentFailed(bidForSession(event.data.object));

    case "payment_intent.payment_failed": {
      const intent = event.data.object;
      const declared = intent.metadata?.bidId;
      return onPaymentFailed(
        getBidByPaymentIntentId(intent.id) ?? (declared ? getBidById(declared) : null),
      );
    }

    case "charge.refunded": {
      const charge = event.data.object;
      // `refunds` is not expanded by default; the most recent one is ours.
      const refund = charge.refunds?.data[0] ?? null;
      return onRefundEvent(
        idOf(charge.payment_intent),
        refund?.id ?? null,
        refund?.status ?? "succeeded",
        charge.metadata?.bidId,
        now,
      );
    }

    case "refund.updated":
    case "charge.refund.updated": {
      const refund = event.data.object;
      return onRefundEvent(
        idOf(refund.payment_intent),
        refund.id,
        refund.status ?? null,
        refund.metadata?.bidId,
        now,
      );
    }

    default:
      // Never make Stripe retry something we chose not to act on.
      return IGNORED(event.type);
  }
}

export async function POST(req: Request): Promise<Response> {
  // The raw text, byte for byte. Parsing to JSON and re-stringifying rewrites
  // key order and whitespace, and the signature covers the bytes.
  const raw = await req.text();

  const parsed = constructWebhookEvent(raw, req.headers.get("stripe-signature") ?? undefined);
  if (!parsed.ok) {
    // Unverifiable is 400 and final: a forged body must never be retried into
    // us. A missing signing secret is our fault and transient, so 503 keeps the
    // event alive until the environment is fixed.
    const status = parsed.code === "not_configured" ? 503 : 400;
    console.error(`[stripe] webhook rejected: ${parsed.message}`);
    return NextResponse.json({ error: parsed.message }, { status });
  }

  const event = parsed.event;
  try {
    const outcome = await dispatch(event, Date.now());
    const status = outcome.retry ? 500 : 200;
    return NextResponse.json({ received: true, type: event.type, ...outcome }, { status });
  } catch (err) {
    // Unexpected: a database write failed, or an invariant the engine defends
    // was violated. 500 so the event comes back rather than being lost.
    console.error(`[stripe] handling ${event.type} (${event.id}) failed:`, err);
    return NextResponse.json(
      { error: "Webhook handler failed.", type: event.type },
      { status: 500 },
    );
  }
}
