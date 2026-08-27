"use client";

import Image from "next/image";
import { useMemo } from "react";
import { formatMoney } from "@/lib/money";
import type { SpotView } from "@/lib/types";

export interface LeaderboardProps {
  spots: SpotView[];
  onBid: (spotKey: string) => void;
  /** Spot keys the visiting bidder currently holds, from /api/me. */
  heldSpots: string[];
  className?: string;
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

/** rank, spot, holder, price, action. Every spot closes at the same moment, so
 *  the clock is the page's, not the row's. */
const ROW =
  "grid grid-cols-[2rem_1fr_auto] items-center gap-x-4 gap-y-3 " +
  "md:grid-cols-[2.5rem_minmax(0,1.4fr)_minmax(0,1fr)_8rem_auto]";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

/**
 * The board under the car: every spot, most expensive first.
 *
 * Rank is the whole point, so it is derived here and nowhere else. Ties break
 * on position along the car rather than arbitrarily, which keeps the order
 * stable while eleven unbid spots all sit at their floor price.
 */
export default function Leaderboard({
  spots,
  onBid,
  heldSpots,
  className = "",
}: LeaderboardProps) {
  const held = useMemo(() => new Set(heldSpots), [heldSpots]);

  const ranked = useMemo(
    () => [...spots].sort((a, b) => b.currentPriceCents - a.currentPriceCents || b.x - a.x),
    [spots],
  );

  const taken = spots.filter((spot) => spot.holder !== null).length;
  const headingId = "leaderboard-heading";

  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id={headingId} className="display-md text-ink">
          Leaderboard
        </h2>
        <p className="tabular text-[14px] text-muted" aria-live="polite" aria-atomic="true">
          {taken} of {spots.length} spots taken
        </p>
      </div>

      {/* Column labels are decoration on a list of articles, so they are hidden
          from the reader: every row already names its own values. */}
      <div
        aria-hidden="true"
        className={`${ROW} hairline-b mt-8 hidden pb-3 text-[11px] uppercase tracking-[0.08em] text-faint md:grid`}
      >
        <span>#</span>
        <span>Spot</span>
        <span>Holder</span>
        <span className="text-right">Price</span>
        <span />
      </div>

      <ul>
        {ranked.map((spot, index) => {
          const rank = index + 1;
          const closed = spot.status === "closed";
          const holder = spot.holder;
          const mine = held.has(spot.key);
          const rowHeadingId = `spot-${spot.key}-name`;

          return (
            <li key={spot.key} data-spot-key={spot.key}>
              <article
                aria-labelledby={rowHeadingId}
                className={`${ROW} hairline-b py-5 transition-colors duration-500 ${
                  closed ? "opacity-60" : ""
                }`}
              >
                <span
                  className={`tabular text-[15px] font-semibold ${
                    rank <= 3 && !closed ? "text-ink" : "text-faint"
                  }`}
                >
                  <span className="sr-only">Rank </span>
                  {rank}
                </span>

                <div className="min-w-0">
                  <h3
                    id={rowHeadingId}
                    className="truncate text-[16px] font-semibold tracking-[-0.015em] text-ink"
                  >
                    {spot.name}
                  </h3>
                  <p className="truncate text-[12px] text-faint">
                    {spot.panel} · {Math.round(spot.widthCm)} × {Math.round(spot.heightCm)} cm
                  </p>
                </div>

                <div className="col-start-2 flex min-w-0 items-center gap-2.5 md:col-start-auto">
                  {holder ? (
                    <>
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-haze">
                        {holder.logoUrl ? (
                          // Uploaded artwork may be SVG, which the image
                          // optimiser refuses by default, so serve the bytes
                          // exactly as they were stored.
                          <Image
                            src={holder.logoUrl}
                            alt=""
                            width={32}
                            height={32}
                            unoptimized
                            className="h-6 w-6 object-contain"
                          />
                        ) : (
                          <span aria-hidden="true" className="text-[11px] font-medium text-faint">
                            {initialsOf(holder.displayName)}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] text-ink">
                          {holder.displayName}
                        </span>
                        {mine ? (
                          <span className="block text-[12px] font-medium text-good">You</span>
                        ) : null}
                      </span>
                    </>
                  ) : (
                    <span className="text-[14px] text-faint">No bids yet</span>
                  )}
                </div>

                <p
                  aria-live="polite"
                  aria-atomic="true"
                  className="tabular col-start-3 row-start-1 text-right text-[18px] font-semibold tracking-[-0.02em] text-ink md:col-start-auto md:row-start-auto"
                >
                  <span className="sr-only">{spot.name} current price </span>
                  {formatMoney(spot.currentPriceCents)}
                </p>

                <div className="col-start-3 flex justify-end md:col-start-auto">
                  <button
                    type="button"
                    disabled={closed}
                    onClick={() => onBid(spot.key)}
                    className={`btn btn-sm shrink-0 ${mine ? "btn-secondary" : "btn-primary"} ${FOCUS_RING}`}
                  >
                    {closed ? "Closed" : mine ? "Raise" : holder ? "Outbid" : "Bid"}
                    <span className="sr-only"> on the {spot.name}</span>
                  </button>
                </div>
              </article>
            </li>
          );
        })}
      </ul>

      {ranked.length === 0 ? (
        <p className="mt-10 text-[15px] text-muted">No spots to show.</p>
      ) : null}
    </section>
  );
}
