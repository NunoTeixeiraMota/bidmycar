"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Countdown from "@/components/Countdown";
import { formatMoney, incrementFor, parseMoneyToCents } from "@/lib/money";
import type { SpotView, StartBidResult } from "@/lib/types";

export interface BidDialogProps {
  /** The spot being bid on. Null means the dialog is shut. */
  spot: SpotView | null;
  onClose: () => void;
  /** True when the visitor already holds this spot; the copy becomes a raise. */
  holding?: boolean;
  /** Prefill from /api/me so a returning bidder doesn't retype. */
  bidder?: { email: string; displayName: string } | null;
  /** AuctionState.serverNow, for the closing clock. */
  serverNow?: number;
  /** Called once a demo-mode bid has settled, so the board can re-read state. */
  onPlaced?: () => void;
}

interface FieldErrors {
  amount?: string;
  email?: string;
  displayName?: string;
}

interface Notice {
  tone: "error" | "info";
  text: string;
  /** An amount the visitor can accept in one click, e.g. after being outbid. */
  raiseToCents?: number;
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Cents to something a person would type back: "1250", or "1250.50". */
function centsToInput(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export default function BidDialog({
  spot,
  onClose,
  holding = false,
  bidder = null,
  serverNow,
  onPlaced,
}: BidDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  const ids = useId();
  const titleId = `${ids}-title`;
  const termsId = `${ids}-terms`;
  const amountId = `${ids}-amount`;
  const emailId = `${ids}-email`;
  const nameId = `${ids}-name`;

  const [amount, setAmount] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formDisabled, setFormDisabled] = useState(false);
  const [demoPlacedCents, setDemoPlacedCents] = useState<number | null>(null);

  // Null means "untouched", which is what lets a later /api/me answer fill the
  // field in without ever overwriting something the visitor has typed.
  const [emailEdit, setEmailEdit] = useState<string | null>(null);
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const email = emailEdit ?? bidder?.email ?? "";
  const displayName = nameEdit ?? bidder?.displayName ?? "";

  // The server can tell us the bar moved under us; that beats the snapshot the
  // board was rendered from until the next state frame arrives.
  const [minOverrideCents, setMinOverrideCents] = useState<number | null>(null);
  const minCents = Math.max(spot?.minimumNextBidCents ?? 0, minOverrideCents ?? 0);

  const spotKey = spot?.key ?? null;

  // Re-arm on every fresh open, during render rather than in an effect so the
  // form never paints one frame of the previous spot's numbers. Keyed on the
  // spot KEY, never on `spot`: the state stream hands us a new object every
  // couple of seconds and re-seeding on that would overwrite what is typed.
  const [armedFor, setArmedFor] = useState<string | null>(null);
  if (spotKey !== null && spotKey !== armedFor) {
    setArmedFor(spotKey);
    setAmount(centsToInput(spot?.minimumNextBidCents ?? 0));
    setFieldErrors({});
    setNotice(null);
    setSubmitting(false);
    setFormDisabled(false);
    setDemoPlacedCents(null);
    setMinOverrideCents(null);
  }

  // showModal() is what buys the focus trap, the inert background, Escape, and
  // the return of focus to whatever opened the dialog — all of which a
  // hand-rolled role="dialog" would have to reimplement badly.
  const isOpen = spotKey !== null;
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (isOpen && !node.open) node.showModal();
    if (!isOpen && node.open) node.close();
  }, [isOpen]);

  // Keyed on the spot, not on `spot`: the object identity changes with every
  // state frame, and re-running this would yank the caret out of whichever
  // field the visitor is in, twice a minute, forever.
  useEffect(() => {
    if (!isOpen) return;
    const target = demoPlacedCents === null ? amountRef.current : doneRef.current;
    target?.focus();
  }, [isOpen, spotKey, demoPlacedCents]);

  const chips = useMemo(() => {
    if (!spot) return [] as Array<{ label: string; cents: number }>;
    const current = spot.currentPriceCents;
    const smallest = Math.max(minCents, current + incrementFor(current));
    const raise = (factor: number) =>
      Math.max(smallest, Math.ceil((current * (1 + factor)) / 100) * 100);

    const candidates = [
      { label: "Minimum", cents: smallest },
      { label: "+10%", cents: raise(0.1) },
      { label: "+25%", cents: raise(0.25) },
    ];
    // At low prices the increment floor already exceeds +10%, and two chips
    // with different labels and identical amounts just read as a bug.
    const seen = new Set<number>();
    return candidates.filter((chip) => {
      if (seen.has(chip.cents)) return false;
      seen.add(chip.cents);
      return true;
    });
  }, [spot, minCents]);

  function close() {
    dialogRef.current?.close();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!spot || submitting || formDisabled) return;

    const cents = parseMoneyToCents(amount);
    const trimmedEmail = email.trim();
    const trimmedName = displayName.trim();

    const errors: FieldErrors = {};
    if (cents === null) errors.amount = "Enter an amount, like 250 or 250.00.";
    else if (cents < minCents)
      errors.amount = `The minimum bid on this spot is ${formatMoney(minCents)}.`;
    if (!EMAIL_SHAPE.test(trimmedEmail))
      errors.email = "Enter an email address we can send the receipt to.";
    if (trimmedName.length < 2)
      errors.displayName = "Enter the name to show beside the spot.";

    setFieldErrors(errors);
    if (cents === null || Object.keys(errors).length > 0) {
      setNotice(null);
      return;
    }

    setNotice(null);
    setSubmitting(true);

    let result: StartBidResult;
    try {
      const response = await fetch("/api/bids", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spotKey: spot.key,
          amountCents: cents,
          email: trimmedEmail,
          displayName: trimmedName,
        }),
      });
      result = (await response.json()) as StartBidResult;
    } catch {
      setSubmitting(false);
      setNotice({
        tone: "error",
        text: "We couldn't reach the auction. Nothing has been charged — check your connection and try again.",
      });
      return;
    }

    if (result.ok) {
      if (result.checkoutUrl) {
        // The button stays in its working state on purpose: this page is about
        // to be replaced by Stripe, and re-enabling it would only flicker.
        setNotice({ tone: "info", text: "Taking you to Stripe to pay…" });
        window.location.assign(result.checkoutUrl);
        return;
      }
      setSubmitting(false);
      if (result.demo) {
        setDemoPlacedCents(cents);
        onPlaced?.();
        return;
      }
      setNotice({
        tone: "error",
        text: "The bid was accepted but no payment page came back. Nothing has been charged — please try again.",
      });
      return;
    }

    setSubmitting(false);

    switch (result.reason) {
      case "below_minimum": {
        const next = result.minimumNextBidCents ?? minCents;
        setMinOverrideCents(next);
        setAmount(centsToInput(next));
        setFieldErrors({
          amount: `Someone bid while you were typing. The minimum is now ${formatMoney(next)}.`,
        });
        setNotice({
          tone: "info",
          text: "Your amount has been raised to the new minimum. Check it, then bid again.",
        });
        amountRef.current?.focus();
        break;
      }
      case "already_holding": {
        const next = result.minimumNextBidCents ?? minCents;
        setNotice({
          tone: "info",
          text: `You already hold this spot. You can raise your own bid to ${formatMoney(next)} or more — the difference is charged, and the whole lot is refunded if someone outbids you.`,
          raiseToCents: next,
        });
        break;
      }
      case "spot_closed":
      case "auction_closed":
      case "spot_unknown": {
        setFormDisabled(true);
        setNotice({
          tone: "error",
          text:
            result.reason === "spot_unknown"
              ? "This spot is no longer listed."
              : `${result.message} Nothing has been charged.`,
        });
        break;
      }
      case "amount_invalid": {
        setFieldErrors({ amount: result.message });
        amountRef.current?.focus();
        break;
      }
      case "bidder_unknown": {
        setFieldErrors({ email: result.message });
        break;
      }
      case "stripe_unavailable": {
        setNotice({
          tone: "error",
          text: "Payments aren't configured on this site, so no bid can be taken right now. Nothing has been charged — this one is ours to fix, not yours.",
        });
        break;
      }
      default: {
        // Every BidRejectionReason is handled above; this only compiles while
        // that stays true.
        const unhandled: never = result.reason;
        setNotice({ tone: "error", text: `Bid rejected (${String(unhandled)}).` });
      }
    }
  }

  const parsedAmount = parseMoneyToCents(amount);
  const payLabel =
    parsedAmount === null ? "Place bid" : `Pay ${formatMoney(parsedAmount)} now`;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(event) => {
        // Escape mid-request would leave a charge in flight with nobody watching.
        if (submitting) event.preventDefault();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !submitting) close();
      }}
      className="m-auto max-h-[92dvh] w-[calc(100%-2rem)] max-w-[540px] overflow-y-auto rounded-[20px] border border-hairline bg-canvas p-0 text-ink shadow-[0_24px_80px_rgba(0,0,0,0.18)] backdrop:bg-black/40"
    >
      {spot ? (
        <div className="p-6 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13px] text-faint">{spot.panel}</p>
              <h2
                id={titleId}
                className="mt-1.5 text-[24px] leading-tight font-semibold tracking-[-0.02em] sm:text-[28px]"
              >
                {demoPlacedCents !== null
                  ? "Bid placed"
                  : holding
                    ? `Raise your bid on the ${spot.name.toLowerCase()}`
                    : spot.name}
              </h2>
            </div>
            <button
              type="button"
              onClick={close}
              disabled={submitting}
              aria-label="Close"
              className={`-mt-1 -mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-200 hover:bg-haze hover:text-ink disabled:opacity-40 ${FOCUS_RING}`}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4">
                <path
                  d="M5 5l10 10M15 5L5 15"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {demoPlacedCents === null ? (
            <>
              <dl className="hairline-t hairline-b mt-6 grid grid-cols-2 gap-y-4 py-5 text-[13px]">
                <div>
                  <dt className="text-faint">Size</dt>
                  <dd className="tabular mt-0.5 text-ink">
                    {Math.round(spot.widthCm)} × {Math.round(spot.heightCm)} cm
                  </dd>
                </div>
                <div>
                  <dt className="text-faint">Opens at</dt>
                  <dd className="tabular mt-0.5 text-ink">{formatMoney(spot.floorPriceCents)}</dd>
                </div>
                <div>
                  <dt className="text-faint">Current price</dt>
                  <dd className="tabular mt-0.5 text-[17px] font-semibold text-ink">
                    {formatMoney(spot.currentPriceCents)}
                  </dd>
                </div>
                <div>
                  <dt className="text-faint">Minimum next bid</dt>
                  <dd className="tabular mt-0.5 text-[17px] font-semibold text-ink">
                    {formatMoney(minCents)}
                  </dd>
                </div>
                {serverNow !== undefined ? (
                  <div className="col-span-2">
                    <dt className="text-faint">This spot closes in</dt>
                    <dd className="mt-0.5 text-[13px]">
                      <Countdown closesAt={spot.closesAt} serverNow={serverNow} compact />
                    </dd>
                  </div>
                ) : null}
              </dl>

              <p id={termsId} className="mt-5 text-[13px] leading-relaxed text-muted">
                You pay now, in full, through Stripe — this is a charge, not a hold. If
                someone outbids you, that payment is refunded automatically and in full;
                you never have to ask. Hold the spot when its clock stops and your logo is
                cut in vinyl and applied to the real car.
              </p>

              <form onSubmit={handleSubmit} noValidate className="mt-7">
                <label htmlFor={amountId} className="block text-[13px] font-medium text-ink">
                  Your bid
                </label>
                <div
                  className={`mt-2 flex items-center rounded-xl border bg-canvas px-3.5 transition-colors duration-200 focus-within:border-signal ${
                    fieldErrors.amount ? "border-live" : "border-hairline"
                  }`}
                >
                  <span aria-hidden="true" className="text-[17px] text-faint">
                    €
                  </span>
                  <input
                    ref={amountRef}
                    id={amountId}
                    name="amount"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={amount}
                    disabled={formDisabled}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setFieldErrors((current) => ({ ...current, amount: undefined }));
                    }}
                    aria-invalid={fieldErrors.amount ? true : undefined}
                    aria-describedby={fieldErrors.amount ? `${amountId}-error` : termsId}
                    className="tabular w-full bg-transparent px-2 py-3 text-[17px] outline-none placeholder:text-faint"
                    placeholder={centsToInput(minCents)}
                  />
                </div>
                {fieldErrors.amount ? (
                  <p id={`${amountId}-error`} role="alert" className="mt-2 text-[12px] text-live">
                    {fieldErrors.amount}
                  </p>
                ) : (
                  <p className="mt-2 text-[12px] text-faint">
                    At least {formatMoney(minCents)}.
                  </p>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {chips.map((chip) => (
                    <button
                      key={chip.label}
                      type="button"
                      disabled={formDisabled}
                      onClick={() => {
                        setAmount(centsToInput(chip.cents));
                        setFieldErrors((current) => ({ ...current, amount: undefined }));
                      }}
                      className={`rounded-full border border-hairline px-3 py-1.5 text-[12px] text-muted transition-colors duration-200 hover:border-ink hover:text-ink disabled:opacity-40 ${FOCUS_RING}`}
                    >
                      {chip.label}
                      <span className="tabular ml-1.5 text-ink">
                        {formatMoney(chip.cents)}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-6 grid gap-5 sm:grid-cols-2">
                  <div>
                    <label htmlFor={nameId} className="block text-[13px] font-medium text-ink">
                      Display name
                    </label>
                    <input
                      id={nameId}
                      name="displayName"
                      type="text"
                      autoComplete="organization"
                      maxLength={40}
                      disabled={formDisabled}
                      value={displayName}
                      onChange={(event) => {
                        setNameEdit(event.target.value);
                        setFieldErrors((current) => ({ ...current, displayName: undefined }));
                      }}
                      aria-invalid={fieldErrors.displayName ? true : undefined}
                      aria-describedby={
                        fieldErrors.displayName ? `${nameId}-error` : `${nameId}-hint`
                      }
                      className={`mt-2 w-full rounded-xl border bg-canvas px-3.5 py-3 text-[15px] outline-none transition-colors duration-200 focus:border-signal ${
                        fieldErrors.displayName ? "border-live" : "border-hairline"
                      }`}
                    />
                    {fieldErrors.displayName ? (
                      <p id={`${nameId}-error`} role="alert" className="mt-2 text-[12px] text-live">
                        {fieldErrors.displayName}
                      </p>
                    ) : (
                      <p id={`${nameId}-hint`} className="mt-2 text-[12px] text-faint">
                        Shown publicly beside the spot you hold.
                      </p>
                    )}
                  </div>

                  <div>
                    <label htmlFor={emailId} className="block text-[13px] font-medium text-ink">
                      Email
                    </label>
                    <input
                      id={emailId}
                      name="email"
                      type="email"
                      autoComplete="email"
                      disabled={formDisabled}
                      value={email}
                      onChange={(event) => {
                        setEmailEdit(event.target.value);
                        setFieldErrors((current) => ({ ...current, email: undefined }));
                      }}
                      aria-invalid={fieldErrors.email ? true : undefined}
                      aria-describedby={
                        fieldErrors.email ? `${emailId}-error` : `${emailId}-hint`
                      }
                      className={`mt-2 w-full rounded-xl border bg-canvas px-3.5 py-3 text-[15px] outline-none transition-colors duration-200 focus:border-signal ${
                        fieldErrors.email ? "border-live" : "border-hairline"
                      }`}
                    />
                    {fieldErrors.email ? (
                      <p id={`${emailId}-error`} role="alert" className="mt-2 text-[12px] text-live">
                        {fieldErrors.email}
                      </p>
                    ) : (
                      <p id={`${emailId}-hint`} className="mt-2 text-[12px] text-faint">
                        Receipt, refunds and your logo upload link. Never shown publicly.
                      </p>
                    )}
                  </div>
                </div>

                {notice ? (
                  <div
                    role={notice.tone === "error" ? "alert" : "status"}
                    className={`mt-6 rounded-xl px-4 py-3 text-[13px] leading-relaxed ${
                      notice.tone === "error" ? "bg-haze text-live" : "bg-haze text-ink"
                    }`}
                  >
                    <p>{notice.text}</p>
                    {notice.raiseToCents !== undefined ? (
                      <button
                        type="button"
                        onClick={() => {
                          const cents = notice.raiseToCents;
                          if (cents === undefined) return;
                          setAmount(centsToInput(cents));
                          setNotice(null);
                          amountRef.current?.focus();
                        }}
                        className={`btn btn-sm btn-secondary mt-3 ${FOCUS_RING}`}
                      >
                        Raise to {formatMoney(notice.raiseToCents)}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
                  <button
                    type="button"
                    onClick={close}
                    disabled={submitting}
                    className={`btn btn-md text-muted hover:text-ink ${FOCUS_RING}`}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting || formDisabled}
                    className={`btn btn-primary btn-md ${FOCUS_RING}`}
                  >
                    {submitting ? "Working…" : formDisabled ? "Bidding closed" : payLabel}
                  </button>
                </div>
              </form>
            </>
          ) : (
            <div className="mt-6">
              <p className="text-[15px] leading-relaxed text-ink">
                You now hold the {spot.name.toLowerCase()} at{" "}
                <span className="tabular font-semibold">{formatMoney(demoPlacedCents)}</span>.
              </p>
              <p className="mt-4 text-[13px] leading-relaxed text-muted">
                This site is running in demo mode: no Stripe keys are configured, so{" "}
                <strong className="font-medium text-ink">no money moved</strong> and no card
                was touched. The bid was settled as though it had been paid. On the live
                auction you would have been sent to Stripe Checkout and charged{" "}
                {formatMoney(demoPlacedCents)} at this point, and refunded in full the moment
                anyone outbid you.
              </p>
              <div className="mt-7 flex justify-end">
                <button
                  ref={doneRef}
                  type="button"
                  onClick={close}
                  className={`btn btn-primary btn-md ${FOCUS_RING}`}
                >
                  Back to the board
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </dialog>
  );
}
