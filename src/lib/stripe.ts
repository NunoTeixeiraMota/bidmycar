import Stripe from "stripe";
import { CAR } from "@/config/car";
import { CURRENCY } from "@/lib/money";

/**
 * Everything that talks to Stripe.
 *
 * Two rules shape this file.
 *
 * DEMO MODE. With no `STRIPE_SECRET_KEY` the app must still work end to end:
 * you can clone this, `npm run seed && npm run dev`, and bid on a spot before
 * you have ever opened a Stripe account. Every call below has a demo path that
 * reports success without money moving, and says so in its result; callers
 * branch on `demo`, they never sniff the environment themselves.
 *
 * NO THROWS. A bid, a webhook and the close job all sit on top of these calls,
 * and a network blip inside Stripe's SDK must surface as a value the caller can
 * decide about, not as an exception unwinding through a database transaction.
 * Everything returns a discriminated result.
 */

export type { Stripe };

/* ------------------------------------------------------------------ *
 * Failure shape
 * ------------------------------------------------------------------ */

export type StripeFailureCode =
  | "not_configured" // no secret key, in a place where the demo path cannot stand in
  | "invalid_request" // Stripe rejected the parameters; retrying identically will not help
  | "duplicate" // idempotency key reused with different parameters: a real double-submit
  | "authentication" // the key is wrong, revoked, or from the other mode
  | "rate_limited"
  | "connection" // never reached Stripe, or the answer never came back
  | "signature" // webhook payload did not verify against the signing secret
  | "api_error" // Stripe's fault
  | "unknown";

export interface StripeFailure {
  ok: false;
  code: StripeFailureCode;
  message: string;
  /** True when the same request, with the same idempotency key, may yet succeed. */
  retryable: boolean;
}

const RETRYABLE: readonly StripeFailureCode[] = ["rate_limited", "connection", "api_error"];

function fail(code: StripeFailureCode, message: string): StripeFailure {
  return { ok: false, code, message, retryable: RETRYABLE.includes(code) };
}

/** Stripe's error taxonomy, narrowed to the handful of decisions a caller has. */
function classify(err: unknown, context: string): StripeFailure {
  if (err instanceof Stripe.errors.StripeIdempotencyError) {
    return fail("duplicate", `${context}: this request was already made with different details.`);
  }
  if (err instanceof Stripe.errors.StripeAuthenticationError) {
    return fail("authentication", `${context}: Stripe rejected the API key.`);
  }
  if (err instanceof Stripe.errors.StripeRateLimitError) {
    return fail("rate_limited", `${context}: rate limited by Stripe.`);
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    return fail("connection", `${context}: could not reach Stripe.`);
  }
  if (err instanceof Stripe.errors.StripeInvalidRequestError) {
    return fail("invalid_request", `${context}: ${err.message}`);
  }
  if (err instanceof Stripe.errors.StripeAPIError) {
    return fail("api_error", `${context}: Stripe returned an error.`);
  }
  if (err instanceof Stripe.errors.StripeError) {
    return fail("unknown", `${context}: ${err.message}`);
  }
  return fail("unknown", `${context}: ${err instanceof Error ? err.message : String(err)}`);
}

/* ------------------------------------------------------------------ *
 * The client
 * ------------------------------------------------------------------ */

let cached: Stripe | null = null;
let cachedKey: string | null = null;

function secretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key ? key : null;
}

export function isStripeConfigured(): boolean {
  return secretKey() !== null;
}

/** The publishable key, for a client that wants to render Stripe's own UI. */
export function publishableKey(): string | null {
  const key = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim();
  return key ? key : null;
}

/**
 * Constructed on first use, never at import.
 *
 * `next build` imports every route module to collect its metadata, and a
 * constructor that threw on a missing key would make a keyless build fail on a
 * machine that will never take a payment.
 */
function client(): Stripe | null {
  const key = secretKey();
  if (!key) return null;
  // Re-keying rather than reusing blindly: tests swap the env between cases.
  if (cached && cachedKey === key) return cached;

  cached = new Stripe(key, {
    // The SDK's own pinned version, so the request always matches the types
    // shipped beside it, and follows them on upgrade instead of drifting.
    apiVersion: Stripe.API_VERSION,
    maxNetworkRetries: 2, // safe: every mutating call below carries an idempotency key
    timeout: 20_000,
    appInfo: { name: "brand-my-datsun", version: "1.0.0" },
  });
  cachedKey = key;
  return cached;
}

/* ------------------------------------------------------------------ *
 * Checkout
 * ------------------------------------------------------------------ */

export interface CreateCheckoutSessionInput {
  bidId: string;
  spotKey: string;
  spotName: string;
  amountCents: number;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
}

export type CheckoutSessionResult =
  | { ok: true; demo: true; sessionId: null; url: null }
  | { ok: true; demo: false; sessionId: string; url: string }
  | StripeFailure;

/** Stripe's minimum; a session may not expire sooner than this. */
const CHECKOUT_TTL_SECONDS = 30 * 60;

/**
 * Quantising the expiry is what makes the idempotency key work.
 *
 * An idempotency key only replays a previous response when the parameters
 * match too. `expires_at` is computed from the clock, so two clicks a second
 * apart would send different parameters under the same key and Stripe would
 * reject the second outright. Rounding the expiry up to a five-minute boundary
 * makes rapid re-submits parameter-identical, so the second click gets the
 * first click's session back instead of a second charge.
 */
function checkoutExpiry(nowSeconds: number): number {
  const bucket = 5 * 60;
  // The extra minute is clock skew: Stripe rejects an expiry less than 30
  // minutes out, measured when the request lands rather than when it was built.
  return Math.ceil((nowSeconds + CHECKOUT_TTL_SECONDS + 60) / bucket) * bucket;
}

/**
 * Open a Checkout session for one bid.
 *
 * DEMO PATH: with no secret key this returns `{ demo: true }` and touches
 * nothing. The caller is expected to settle the bid immediately: the bid
 * behaves exactly as a paid one, minus the money.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
): Promise<CheckoutSessionResult> {
  const stripe = client();
  if (!stripe) return { ok: true, demo: true, sessionId: null, url: null };

  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return fail("invalid_request", "A charge must be a whole number of cents above zero.");
  }

  const email = input.customerEmail?.trim();

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        line_items: [
          {
            quantity: 1,
            price_data: {
              // Stripe wants it lower-cased; the domain holds it as "EUR".
              currency: CURRENCY.toLowerCase(),
              unit_amount: input.amountCents,
              product_data: {
                name: input.spotName,
                description: `Advertising spot on the ${CAR.name}. Refunded in full if you are outbid.`,
              },
            },
          },
        ],
        ...(email ? { customer_email: email } : {}),
        client_reference_id: input.bidId,
        // On both the session and the payment intent: a refund or dispute
        // webhook carries the intent, not the session, and we still need to
        // know which bid it belongs to.
        metadata: { bidId: input.bidId, spotKey: input.spotKey },
        payment_intent_data: {
          description: `${input.spotName} on the ${CAR.name}`,
          metadata: { bidId: input.bidId, spotKey: input.spotKey },
        },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: checkoutExpiry(Math.floor(Date.now() / 1000)),
      },
      { idempotencyKey: `checkout:${input.bidId}` },
    );

    if (!session.url) {
      // Only happens for non-hosted UI modes, which we never ask for.
      return fail("api_error", "Stripe returned a checkout session with no URL.");
    }
    return { ok: true, demo: false, sessionId: session.id, url: session.url };
  } catch (err) {
    return classify(err, "Could not start checkout");
  }
}

export type RetrieveSessionResult =
  | { ok: true; demo: true; session: null }
  | { ok: true; demo: false; session: Stripe.Checkout.Session }
  | StripeFailure;

/**
 * Read a Checkout session back, for the return-from-Stripe page.
 *
 * DEMO PATH: no keys means no session ever existed, so this reports
 * `{ demo: true, session: null }`; the caller should trust its own bid row,
 * which the demo checkout already settled.
 */
export async function retrieveSession(sessionId: string): Promise<RetrieveSessionResult> {
  const stripe = client();
  if (!stripe) return { ok: true, demo: true, session: null };

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return { ok: true, demo: false, session };
  } catch (err) {
    return classify(err, "Could not read the checkout session");
  }
}

/** `payment_intent` comes back as an id, an expanded object, or nothing. */
export function paymentIntentIdOf(session: Stripe.Checkout.Session): string | null {
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === "string" ? pi : pi.id;
}

/* ------------------------------------------------------------------ *
 * Webhooks
 * ------------------------------------------------------------------ */

export type WebhookEventResult = { ok: true; event: Stripe.Event } | StripeFailure;

/**
 * Verify and parse a webhook.
 *
 * There is deliberately no demo path: an unverified body is attacker-supplied
 * JSON that would otherwise be allowed to mark bids paid. With no signing
 * secret this fails closed and the route should answer 503. In demo mode
 * nothing calls it, because nothing ever sent a payment to Stripe.
 *
 * The raw body matters: parse the request with `req.text()`, never `req.json()`
 * and re-stringify, or the signature will not match.
 */
export function constructWebhookEvent(
  rawBody: string | Buffer,
  signature: string | string[] | undefined,
): WebhookEventResult {
  const stripe = client();
  if (!stripe) return fail("not_configured", "STRIPE_SECRET_KEY is not set.");

  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return fail(
      "not_configured",
      "STRIPE_WEBHOOK_SECRET is not set, so webhook signatures cannot be verified.",
    );
  }
  if (!signature || Array.isArray(signature)) {
    return fail("signature", "Missing stripe-signature header.");
  }

  try {
    return { ok: true, event: stripe.webhooks.constructEvent(rawBody, signature, secret) };
  } catch (err) {
    if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
      return fail("signature", "Webhook signature verification failed.");
    }
    return classify(err, "Could not parse the webhook");
  }
}

/* ------------------------------------------------------------------ *
 * Refunds
 * ------------------------------------------------------------------ */

export type RefundReason = Stripe.RefundCreateParams.Reason;

export type RefundResult =
  | {
      ok: true;
      refundId: string;
      status: string;
      /** No money moved: either there are no keys, or this bid never had a charge. */
      demo: boolean;
      /** The charge was already refunded; this is the existing refund, not a new one. */
      alreadyRefunded: boolean;
    }
  | StripeFailure;

/**
 * A refund id for a bid that never took real money, derived from whatever
 * identifies it so a retried close job produces the same id twice.
 */
function demoRefundId(seed: string | null): string {
  const suffix = seed ? Buffer.from(seed).toString("base64url").slice(0, 20) : "unpaid";
  return `re_demo_${suffix}`;
}

/**
 * Refund a payment in full.
 *
 * Being outbid triggers this, and so does closing the auction, and the close
 * job is expected to be re-run after a partial failure. So it has to be safe to
 * call twice: the idempotency key collapses a genuine repeat, and a charge
 * Stripe has already refunded is reported as success carrying the original
 * refund id rather than as an error that would abort the rest of the batch.
 *
 * DEMO PATH: no keys, or a bid with no payment intent, means nothing was ever
 * charged. Both report success with a synthetic id and `demo: true`; a demo
 * auction still has to be able to displace a holder and close.
 */
export async function refundPayment(
  paymentIntentId: string | null,
  reason: RefundReason = "requested_by_customer",
): Promise<RefundResult> {
  const stripe = client();
  if (!stripe || !paymentIntentId) {
    return {
      ok: true,
      refundId: demoRefundId(paymentIntentId),
      status: "succeeded",
      demo: true,
      alreadyRefunded: false,
    };
  }

  try {
    const refund = await stripe.refunds.create(
      { payment_intent: paymentIntentId, reason },
      { idempotencyKey: `refund:${paymentIntentId}` },
    );
    return {
      ok: true,
      refundId: refund.id,
      status: refund.status ?? "pending",
      demo: false,
      alreadyRefunded: false,
    };
  } catch (err) {
    if (
      err instanceof Stripe.errors.StripeInvalidRequestError &&
      (err.code === "charge_already_refunded" || err.code === "payment_intent_unexpected_state")
    ) {
      const existing = await findExistingRefund(stripe, paymentIntentId);
      if (existing) {
        return {
          ok: true,
          refundId: existing.id,
          status: existing.status ?? "succeeded",
          demo: false,
          alreadyRefunded: true,
        };
      }
      // Unexpected state with no refund to show for it: the payment never
      // succeeded, so there is nothing to give back and nothing to retry.
      return fail("invalid_request", `Nothing to refund on ${paymentIntentId}: ${err.message}`);
    }
    return classify(err, `Could not refund ${paymentIntentId}`);
  }
}

async function findExistingRefund(
  stripe: Stripe,
  paymentIntentId: string,
): Promise<Stripe.Refund | null> {
  try {
    const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 1 });
    return refunds.data[0] ?? null;
  } catch {
    // The lookup is a courtesy; its failure must not turn a completed refund
    // into a reported error.
    return null;
  }
}
