"use client";

import Image from "next/image";
import Link from "next/link";
import {
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import { AUCTION, CAR, SPOTS, metricsFor } from "@/config/car";
import { formatMoney } from "@/lib/money";
import type { Artwork, Bid, SpotStatus } from "@/lib/types";

/**
 * Where Stripe sends the buyer back to.
 *
 * Settlement happens in the webhook, not here — a buyer who closes this tab
 * must still get their spot. So this page never writes anything about payment;
 * it reads the bid and waits for the webhook to have landed.
 */

/** The spot shape this page needs, satisfied by both `Spot` and `SpotView`. */
interface BidPageSpot {
  key: string;
  name: string;
  panel: string;
  widthCm: number;
  heightCm: number;
  status: SpotStatus;
  closesAt: number;
  floorPriceCents: number;
  currentPriceCents?: number;
}

interface BidPayload {
  bid: Bid;
  spot: BidPageSpot;
  artwork: Artwork | null;
}

type Phase = "awaiting_payment" | "failed" | "refunded" | "upload" | "review" | "approved";

/** Resolution a large-format printer needs to hold a clean edge. */
const TARGET_DPI = 150;
const POLL_MS = 3_000;
const MAX_MB = Math.round(AUCTION.maxLogoBytes / (1024 * 1024));

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

function phaseOf(payload: BidPayload): Phase {
  const { bid, artwork } = payload;
  if (bid.status === "pending_payment") return "awaiting_payment";
  if (bid.status === "failed" || bid.status === "expired") return "failed";
  if (bid.status === "outbid" || bid.status === "refunded") return "refunded";
  if (!artwork || artwork.reviewStatus === "awaiting_upload") return "upload";
  if (artwork.reviewStatus === "pending") return "review";
  if (artwork.reviewStatus === "rejected") return "upload";
  return "approved";
}

/** Server copy is written for the buyer; show it rather than paraphrasing it. */
function serverMessage(payload: unknown, fallback: string): string {
  if (typeof payload !== "object" || payload === null) return fallback;
  const record = payload as Record<string, unknown>;
  for (const key of ["error", "message", "reason", "detail"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return fallback;
}

function formatWhen(epochMs: number): string {
  return new Intl.DateTimeFormat("en-IE", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(epochMs));
}

export default function BidPage({ params }: { params: Promise<{ bidId: string }> }) {
  const { bidId } = use(params);

  const [payload, setPayload] = useState<BidPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/bids/${encodeURIComponent(bidId)}`, {
        cache: "no-store",
      });
      if (response.status === 404) {
        if (!alive.current) return;
        setMissing(true);
        return;
      }
      if (!response.ok) throw new Error(`responded ${response.status}`);
      const next = (await response.json()) as BidPayload;
      if (!alive.current) return;
      setPayload(next);
      setMissing(false);
      setLoadError(null);
    } catch {
      if (!alive.current) return;
      setLoadError("Couldn't reach the server. Retrying.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [bidId]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const phase = payload ? phaseOf(payload) : null;

  // The webhook settles the payment, and it may land a second or two after
  // Stripe redirects the buyer here. Poll until it has, then stop.
  useEffect(() => {
    if (phase !== "awaiting_payment") return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase, load]);

  if (loading) {
    return (
      <Frame>
        <p className="eyebrow">Your bid</p>
        <h1 className="display-md mt-4 text-ink">Loading your bid&hellip;</h1>
      </Frame>
    );
  }

  if (missing) {
    return (
      <Frame>
        <p className="eyebrow">Not found</p>
        <h1 className="display-md mt-4 text-ink">We can&rsquo;t find that bid.</h1>
        <p className="lede mt-4">
          The link may be incomplete, or the bid may belong to a different browser session. If you
          have the confirmation email, the link in it is the reliable one.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/#spots" className={`btn btn-primary btn-md ${FOCUS_RING}`}>
            Back to the spots
          </Link>
        </div>
      </Frame>
    );
  }

  if (!payload) {
    return (
      <Frame>
        <p className="eyebrow">Your bid</p>
        <h1 className="display-md mt-4 text-ink">That didn&rsquo;t load.</h1>
        <p className="lede mt-4">{loadError ?? "Something went wrong reading your bid."}</p>
        <button
          type="button"
          onClick={() => void load()}
          className={`btn btn-primary btn-md mt-8 ${FOCUS_RING}`}
        >
          Try again
        </button>
      </Frame>
    );
  }

  return <BidView payload={payload} bidId={bidId} onRefresh={load} />;
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="section">
      <div className="shell">
        <div className="max-w-[680px]">{children}</div>
      </div>
    </main>
  );
}

function StatusPill({ tone, children }: { tone: "live" | "good" | "muted"; children: string }) {
  const styles =
    tone === "good"
      ? "bg-good/10 text-good"
      : tone === "live"
        ? "bg-live/10 text-live"
        : "bg-slate text-muted";
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-[12px] font-medium ${styles}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * The bid, in whichever state it is in
 * ------------------------------------------------------------------ */

function BidView({
  payload,
  bidId,
  onRefresh,
}: {
  payload: BidPayload;
  bidId: string;
  onRefresh: () => Promise<void>;
}) {
  const { bid, spot, artwork } = payload;
  const phase = phaseOf(payload);

  // Geometry lives in config, not in the API payload, so the overlay works
  // whether the route hands back a Spot row or a SpotView.
  const geometry = useMemo(() => SPOTS.find((s) => s.key === spot.key) ?? null, [spot.key]);
  const widthCm = spot.widthCm || (geometry ? metricsFor(geometry).widthCm : 0);
  const heightCm = spot.heightCm || (geometry ? metricsFor(geometry).heightCm : 0);

  const pill =
    phase === "approved"
      ? { tone: "good" as const, label: "On the car" }
      : phase === "refunded"
        ? { tone: "muted" as const, label: "Outbid — refunded" }
        : phase === "failed"
          ? { tone: "live" as const, label: "Payment didn't complete" }
          : phase === "review"
            ? { tone: "muted" as const, label: "Artwork under review" }
            : phase === "awaiting_payment"
              ? { tone: "muted" as const, label: "Confirming payment" }
              : { tone: "good" as const, label: "You hold this spot" };

  return (
    <main>
      <section className="hairline-b bg-haze py-14 sm:py-20">
        <div className="shell">
          <div className="max-w-[680px]">
            <p className="eyebrow">{spot.panel}</p>
            <h1 className="display-lg mt-3 text-ink">{spot.name}</h1>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
              <p className="tabular text-[22px] font-semibold tracking-[-0.02em] text-ink">
                {formatMoney(bid.amountCents)}
              </p>
              <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
              <p className="tabular text-[13px] text-faint">
                Bid {bid.id.slice(0, 12)} &middot; {formatWhen(bid.createdAt)}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="max-w-[680px]">
            {phase === "awaiting_payment" ? (
              <AwaitingPayment onRefresh={onRefresh} />
            ) : phase === "failed" ? (
              <PaymentFailed spotKey={spot.key} />
            ) : phase === "refunded" ? (
              <Refunded bid={bid} spot={spot} />
            ) : phase === "review" ? (
              <UnderReview />
            ) : phase === "approved" && artwork ? (
              <Approved artwork={artwork} spotKey={spot.key} />
            ) : (
              <UploadPanel
                bidId={bidId}
                artwork={artwork}
                spotName={spot.name}
                widthCm={widthCm}
                heightCm={heightCm}
                won={bid.status === "won"}
                onUploaded={onRefresh}
              />
            )}
          </div>

          <div className="hairline-t mt-16 max-w-[680px] pt-8 text-[13px] leading-[1.6] text-faint">
            <p>
              Your card was charged {formatMoney(bid.amountCents)} when you bid. If somebody pays
              more for {spot.name}, you lose the spot and this exact amount is refunded to the same
              card automatically &mdash; you do not have to ask.{" "}
              <Link href="/terms" className={`text-signal hover:underline ${FOCUS_RING}`}>
                The conditions
              </Link>{" "}
              say it properly.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

/* --------------------------------------------------------- states */

function AwaitingPayment({ onRefresh }: { onRefresh: () => Promise<void> }) {
  return (
    <div aria-live="polite">
      <h2 className="display-md text-ink">Confirming your payment.</h2>
      <p className="lede mt-5">
        Stripe has sent you back but the confirmation can take a few seconds to reach us. This page
        checks every few seconds and will move on by itself.
      </p>
      <p className="mt-5 text-[15px] leading-[1.6] text-muted">
        You do not need to pay again, and you do not need to keep this tab open &mdash; your spot is
        decided by the payment, not by this page. If it is still saying this in a minute or two,
        something has gone wrong and we would like to hear about it.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void onRefresh()}
          className={`btn btn-secondary btn-md ${FOCUS_RING}`}
        >
          Check now
        </button>
        <a
          href="mailto:hello@brandmydatsun.com"
          className={`btn btn-secondary btn-md ${FOCUS_RING}`}
        >
          Email us
        </a>
      </div>
    </div>
  );
}

function PaymentFailed({ spotKey }: { spotKey: string }) {
  return (
    <div>
      <h2 className="display-md text-ink">This payment didn&rsquo;t go through.</h2>
      <p className="lede mt-5">
        The checkout was abandoned or the card was declined, so no money was taken and the spot was
        never held. Nothing is owed and there is nothing to refund.
      </p>
      <p className="mt-5 text-[15px] leading-[1.6] text-muted">
        The spot may well still be open. Bidding again starts a fresh checkout.
      </p>
      <div className="mt-8">
        <Link href={`/#spot-${spotKey}-name`} className={`btn btn-primary btn-md ${FOCUS_RING}`}>
          Try that spot again
        </Link>
      </div>
    </div>
  );
}

function Refunded({ bid, spot }: { bid: Bid; spot: BidPageSpot }) {
  const settled = bid.status === "refunded";
  return (
    <div>
      <h2 className="display-md text-ink">Somebody outbid you on {spot.name}.</h2>
      <p className="lede mt-5">
        You no longer hold the spot, and {formatMoney(bid.amountCents)} &mdash; all of it &mdash; is
        going back to the card you paid with. Nothing was deducted.
      </p>
      <dl className="mt-8 grid gap-px overflow-hidden rounded-2xl bg-hairline sm:grid-cols-2">
        <div className="bg-canvas p-6">
          <dt className="text-[12px] uppercase tracking-[0.06em] text-faint">Refund</dt>
          <dd className="tabular mt-2 text-[19px] font-semibold text-ink">
            {formatMoney(bid.amountCents)}
          </dd>
          <dd className="mt-1 text-[13px] text-muted">
            {settled && bid.refundedAt
              ? `Issued ${formatWhen(bid.refundedAt)}`
              : "Being issued now"}
          </dd>
        </div>
        <div className="bg-canvas p-6">
          <dt className="text-[12px] uppercase tracking-[0.06em] text-faint">
            {spot.status === "closed" ? "Spot closed" : "Spot now at"}
          </dt>
          <dd className="tabular mt-2 text-[19px] font-semibold text-ink">
            {formatMoney(spot.currentPriceCents ?? spot.floorPriceCents)}
          </dd>
          <dd className="mt-1 text-[13px] text-muted">
            {spot.status === "closed" ? "Bidding has ended" : "Still open to bids"}
          </dd>
        </div>
      </dl>
      <p className="mt-6 text-[15px] leading-[1.6] text-muted">
        Refunds leave us immediately. How long they take to appear on your statement is your
        bank&rsquo;s decision &mdash; five to ten working days is normal, and neither of us can
        hurry it.
      </p>
      {spot.status !== "closed" ? (
        <div className="mt-8">
          <Link href="/#spots" className={`btn btn-primary btn-md ${FOCUS_RING}`}>
            Bid again
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function UnderReview() {
  return (
    <div aria-live="polite">
      <h2 className="display-md text-ink">Your artwork is with a human.</h2>
      <p className="lede mt-5">
        It is uploaded and queued for review. Somebody looks at every file before it goes anywhere
        near the car; expect a decision within a day.
      </p>
      <p className="mt-5 text-[15px] leading-[1.6] text-muted">
        If it is rejected you will get the reason and a chance to send something else. Nothing about
        review affects your hold on the spot &mdash; that is decided by the bidding.
      </p>
      <div className="mt-8">
        <Link href="/#spots" className={`btn btn-secondary btn-md ${FOCUS_RING}`}>
          Back to the board
        </Link>
      </div>
    </div>
  );
}

function Approved({ artwork, spotKey }: { artwork: Artwork; spotKey: string }) {
  const geometry = SPOTS.find((s) => s.key === spotKey) ?? null;
  return (
    <div>
      <h2 className="display-md text-ink">Approved. It&rsquo;s on the car.</h2>
      <p className="lede mt-5">
        Your artwork passed review and is showing on the board. When the spot&rsquo;s clock stops it
        gets cut in removable cast vinyl and applied to the real panel.
      </p>

      <div
        className="mt-10 w-full bg-haze"
        style={{ aspectRatio: `${CAR.photoWidth} / ${CAR.photoHeight}` }}
      >
        <div className="relative h-full w-full">
          <Image
            src={CAR.photo}
            alt={`${CAR.name} in profile — ${CAR.subtitle}`}
            fill
            sizes="(max-width: 768px) 100vw, 680px"
            className="object-contain"
          />
          {geometry ? (
            <div
              className="absolute"
              style={{
                left: `${geometry.x}%`,
                top: `${geometry.y}%`,
                width: `${geometry.w}%`,
                height: `${geometry.h}%`,
              }}
            >
              <Image
                src={`/api/artwork/${artwork.id}/file`}
                alt={`${artwork.filename}, applied to the ${spotKey} spot`}
                fill
                unoptimized
                className="object-contain"
              />
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-6 tabular text-[13px] text-faint">
        {artwork.filename} &middot; {(artwork.byteSize / 1024).toFixed(0)} KB &middot;{" "}
        {artwork.mimeType}
      </p>

      <p className="mt-6 text-[15px] leading-[1.6] text-muted">
        Want to change it? Email us before the spot closes and we will reopen the upload.
      </p>
      <div className="mt-8">
        <Link href="/#spots" className={`btn btn-secondary btn-md ${FOCUS_RING}`}>
          Back to the board
        </Link>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- upload */

function UploadPanel({
  bidId,
  artwork,
  spotName,
  widthCm,
  heightCm,
  won,
  onUploaded,
}: {
  bidId: string;
  artwork: Artwork | null;
  spotName: string;
  widthCm: number;
  heightCm: number;
  won: boolean;
  onUploaded: () => Promise<void>;
}) {
  const inputId = useId();
  const [picked, setPicked] = useState<{ file: File; previewUrl: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An object URL is only released by hand. Hold at most one, and drop it the
  // moment it is replaced rather than waiting for a render to notice.
  const previewUrl = useRef<string | null>(null);

  function choose(candidate: File | null) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = candidate ? URL.createObjectURL(candidate) : null;
    setPicked(
      candidate && previewUrl.current
        ? { file: candidate, previewUrl: previewUrl.current }
        : null,
    );
  }

  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );

  const rejected = artwork?.reviewStatus === "rejected";

  const pxWide = Math.round((widthCm / 2.54) * TARGET_DPI);
  const pxHigh = Math.round((heightCm / 2.54) * TARGET_DPI);

  function accept(candidate: File | null) {
    setError(null);
    if (!candidate) return;
    // `as const` narrows the list to a literal union; the browser's MIME string is
    // just a string, so compare against it as one.
    if (!(AUCTION.acceptedLogoTypes as readonly string[]).includes(candidate.type)) {
      setError(
        `${candidate.name} is ${candidate.type || "an unrecognised type"}. Send PNG, SVG, JPEG or WebP.`,
      );
      return;
    }
    if (candidate.size > AUCTION.maxLogoBytes) {
      setError(
        `${candidate.name} is ${(candidate.size / (1024 * 1024)).toFixed(1)} MB. The limit is ${MAX_MB} MB.`,
      );
      return;
    }
    choose(candidate);
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    accept(event.target.files?.[0] ?? null);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    accept(event.dataTransfer.files?.[0] ?? null);
  }

  async function submit() {
    const file = picked?.file;
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("bidId", bidId);
      body.append("file", file);

      const response = await fetch("/api/artwork", { method: "POST", body });
      const parsed: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        setError(serverMessage(parsed, `Upload failed (${response.status}).`));
        return;
      }
      choose(null);
      await onUploaded();
    } catch {
      setError("The upload didn't reach us. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="display-md text-ink">
        {won ? `You won ${spotName}. Send us your logo.` : `Send us your logo.`}
      </h2>
      <p className="lede mt-5">
        {won
          ? "The bidding is over and the panel is yours. One file is all we need."
          : "You hold this spot. Upload your artwork now and it will be reviewed and ready the moment the clock stops."}
      </p>

      {rejected && artwork ? (
        <div className="mt-8 rounded-2xl border border-live/30 bg-live/5 p-6">
          <h3 className="text-[15px] font-semibold text-live">
            The last file was rejected
          </h3>
          <p className="mt-2 text-[15px] leading-[1.6] text-ink">
            {artwork.rejectionReason ?? "No reason was recorded."}
          </p>
          <p className="mt-2 text-[13px] text-muted">
            Send a replacement below. Your spot is unaffected.
          </p>
        </div>
      ) : null}

      <dl className="mt-10 grid gap-px overflow-hidden rounded-2xl bg-hairline sm:grid-cols-3">
        <div className="bg-canvas p-5">
          <dt className="text-[12px] uppercase tracking-[0.06em] text-faint">Printed size</dt>
          <dd className="tabular mt-2 text-[17px] font-semibold text-ink">
            {Math.round(widthCm)} &times; {Math.round(heightCm)} cm
          </dd>
        </div>
        <div className="bg-canvas p-5">
          <dt className="text-[12px] uppercase tracking-[0.06em] text-faint">
            Raster at {TARGET_DPI} dpi
          </dt>
          <dd className="tabular mt-2 text-[17px] font-semibold text-ink">
            {pxWide} &times; {pxHigh} px
          </dd>
        </div>
        <div className="bg-canvas p-5">
          <dt className="text-[12px] uppercase tracking-[0.06em] text-faint">Accepted</dt>
          <dd className="mt-2 text-[17px] font-semibold text-ink">PNG SVG JPEG WebP</dd>
          <dd className="mt-1 text-[13px] text-muted">up to {MAX_MB} MB</dd>
        </div>
      </dl>

      <p className="mt-4 text-[14px] leading-[1.6] text-muted">
        SVG is best &mdash; it is what the cutter wants and it scales to the panel without
        softening. Transparent background, and keep important detail a few millimetres inside the
        edge.
      </p>

      <input
        id={inputId}
        type="file"
        accept={AUCTION.acceptedLogoTypes.join(",")}
        onChange={onChange}
        className="peer sr-only"
      />
      <label
        htmlFor={inputId}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`mt-8 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-14 text-center transition-colors duration-200 ease-showroom peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal ${
          dragging ? "border-signal bg-signal/5" : "border-hairline bg-haze hover:border-faint"
        }`}
      >
        <span className="text-[15px] font-medium text-ink">
          Drag your logo here, or choose a file
        </span>
        <span className="mt-2 text-[13px] text-muted">
          PNG, SVG, JPEG or WebP &middot; up to {MAX_MB} MB
        </span>
      </label>

      {error ? (
        <p role="alert" className="mt-5 text-[15px] leading-[1.6] text-live">
          {error}
        </p>
      ) : null}

      {picked ? (
        <div className="mt-8 flex flex-col gap-5 rounded-2xl border border-hairline p-5 sm:flex-row sm:items-center">
          {/* A checkerboard behind the preview: most logos are transparent PNGs
              and white-on-white looks like a failed upload. */}
          <div
            className="h-28 w-28 shrink-0 rounded-xl border border-hairline"
            style={{
              backgroundImage:
                "linear-gradient(45deg,#e8e8ed 25%,transparent 25%,transparent 75%,#e8e8ed 75%),linear-gradient(45deg,#e8e8ed 25%,transparent 25%,transparent 75%,#e8e8ed 75%)",
              backgroundSize: "16px 16px",
              backgroundPosition: "0 0, 8px 8px",
            }}
          >
            {/* A blob: URL from the file the visitor just picked — nothing for
                next/image to optimise, and it must not be routed through the
                image loader. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={picked.previewUrl}
              alt={`Preview of ${picked.file.name}`}
              className="h-full w-full object-contain p-2"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-medium text-ink">{picked.file.name}</p>
            <p className="tabular mt-1 text-[13px] text-muted">
              {(picked.file.size / 1024).toFixed(0)} KB &middot; {picked.file.type}
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                className={`btn btn-primary btn-md ${FOCUS_RING}`}
              >
                {busy ? "Uploading…" : "Upload this logo"}
              </button>
              <button
                type="button"
                onClick={() => choose(null)}
                disabled={busy}
                className={`btn btn-secondary btn-md ${FOCUS_RING}`}
              >
                Choose another
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <p className="mt-8 text-[13px] leading-[1.6] text-faint">
        By uploading you confirm you own the artwork or are licensed to use it, and you allow us to
        reproduce it in vinyl on the car and photograph the car with it on. A human reviews every
        file, and we may reject anything we would not want to drive around with.
      </p>
    </div>
  );
}
