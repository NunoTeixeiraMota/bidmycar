"use client";

import Image from "next/image";
import Countdown from "@/components/Countdown";
import { formatMoney } from "@/lib/money";
import type { SpotView } from "@/lib/types";

export interface SpotCardProps {
  spot: SpotView;
  /** 1-based position in the visible list, shown as the index chip. */
  index: number;
  /** The server's clock, from AuctionState. Null suppresses the countdown
   *  rather than falling back to a browser clock that may be minutes out. */
  serverNow: number | null;
  /** True when the visiting bidder is the current holder. */
  held: boolean;
  onBid: (spotKey: string) => void;
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

/**
 * Size bands, from the area actually billed — the roundel is an ellipse and
 * covers a quarter less than the rectangle it is measured in.
 */
function tierFor(spot: SpotView): string {
  const coverage = spot.shape === "ellipse" ? Math.PI / 4 : 1;
  const areaCm2 = spot.widthCm * spot.heightCm * coverage;
  if (areaCm2 >= 800) return "Large";
  if (areaCm2 >= 400) return "Medium";
  if (areaCm2 >= 250) return "Small";
  return "Compact";
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export default function SpotCard({ spot, index, serverNow, held, onBid }: SpotCardProps) {
  const headingId = `spot-${spot.key}-name`;
  const closed = spot.status === "closed";
  const holder = spot.holder;

  const actionLabel = closed
    ? "Bidding closed"
    : held
      ? "Raise your bid"
      : holder
        ? "Outbid"
        : "Take this spot";

  return (
    <article
      aria-labelledby={headingId}
      className={`flex flex-col rounded-[18px] border bg-canvas p-5 transition-colors duration-500 sm:p-6 ${
        closed ? "border-hairline opacity-70" : held ? "border-good/45" : "border-hairline"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="tabular inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md bg-haze px-1.5 text-[11px] font-medium text-faint">
              {String(index).padStart(2, "0")}
            </span>
            <span className="truncate text-[13px] text-muted">
              {tierFor(spot)} · {Math.round(spot.widthCm)} × {Math.round(spot.heightCm)} cm
            </span>
          </div>

          <h3
            id={headingId}
            className="mt-2.5 text-[19px] font-semibold tracking-[-0.015em] text-ink"
          >
            {spot.name}
          </h3>
          <p className="mt-1 text-[13px] text-faint">{spot.panel}</p>
        </div>

        <div className="shrink-0 text-right">
          <p
            aria-live="polite"
            aria-atomic="true"
            className="tabular text-[26px] font-semibold tracking-[-0.022em] text-ink sm:text-[30px]"
          >
            <span className="sr-only">{spot.name} current price </span>
            {formatMoney(spot.currentPriceCents)}
          </p>
          <p className="mt-0.5 text-[12px] text-faint">
            {spot.bidCount === 0
              ? "Opening price"
              : `${spot.bidCount} bid${spot.bidCount === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      <div className="mt-4 min-h-[1.25rem] text-[12px]">
        {closed ? (
          <span className="text-faint">Closed</span>
        ) : serverNow === null ? null : (
          <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
            <span className="text-faint">Closes in</span>
            <Countdown closesAt={spot.closesAt} serverNow={serverNow} compact />
          </span>
        )}
      </div>

      {spot.inExtensionWindow && !closed ? (
        <p className="mt-1.5 text-[12px] text-live">
          Final minutes — a bid now pushes this clock out by five.
        </p>
      ) : null}

      <div className="hairline-t mt-5 flex items-center justify-between gap-4 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          {holder ? (
            <>
              <span className="flex h-11 w-[104px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-haze">
                {holder.logoUrl ? (
                  // Uploaded artwork may be SVG, which the image optimiser
                  // refuses by default — serve the bytes as they were stored.
                  <Image
                    src={holder.logoUrl}
                    alt={`${holder.displayName} logo`}
                    width={104}
                    height={44}
                    unoptimized
                    className="max-h-9 w-auto max-w-[88px] object-contain"
                  />
                ) : (
                  <span aria-hidden="true" className="text-[13px] font-medium text-faint">
                    {initialsOf(holder.displayName)}
                  </span>
                )}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-ink">
                  {holder.displayName}
                </span>
                <span
                  className={`block truncate text-[12px] ${held ? "font-medium text-good" : "text-faint"}`}
                >
                  {held
                    ? "You hold this spot"
                    : holder.artworkPending
                      ? "Logo under review"
                      : holder.logoUrl
                        ? "Current holder"
                        : "Logo to come"}
                </span>
              </span>
            </>
          ) : (
            <>
              <span
                aria-hidden="true"
                className="flex h-11 w-[104px] shrink-0 items-center justify-center rounded-lg border border-dashed border-hairline text-[12px] text-faint"
              >
                Open
              </span>
              <span className="text-[12px] text-faint">No bids yet</span>
            </>
          )}
        </div>

        <button
          type="button"
          disabled={closed}
          onClick={() => onBid(spot.key)}
          className={`btn btn-sm shrink-0 ${held ? "btn-secondary" : "btn-primary"} ${FOCUS_RING}`}
        >
          {actionLabel}
          <span className="sr-only"> — {spot.name}</span>
        </button>
      </div>
    </article>
  );
}
