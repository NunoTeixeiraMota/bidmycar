"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import SpotCard from "@/components/SpotCard";
import type { SpotView } from "@/lib/types";

export interface SpotListProps {
  spots: SpotView[];
  onBid: (spotKey: string) => void;
  /** Spot keys the visiting bidder currently holds, from /api/me. */
  heldSpots: string[];
  /** AuctionState.serverNow. Omit and the countdowns fall back to the browser's
   *  clock, which on a phone can be minutes out — pass it whenever you have it. */
  serverNow?: number;
  /** Spots in the auction as a whole, when `spots` is a filtered view. */
  totalSpots?: number;
  className?: string;
}

type SortKey = "price" | "position";

const SORTS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "price", label: "Price" },
  { key: "position", label: "Position" },
];

/**
 * Clock of last resort, read once when the bundle loads. It is served through
 * useSyncExternalStore so the server snapshot (null) is what hydration matches
 * against and the client's number only lands afterwards — the same reason the
 * real `serverNow` is preferred whenever the caller has it.
 */
const LOADED_AT_MS = Date.now();
const NEVER_CHANGES = () => () => {};
const clientClock = (): number | null => LOADED_AT_MS;
const serverClock = (): number | null => null;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

export default function SpotList({
  spots,
  onBid,
  heldSpots,
  serverNow,
  totalSpots,
  className = "",
}: SpotListProps) {
  const [sort, setSort] = useState<SortKey>("price");

  const fallbackClock = useSyncExternalStore(NEVER_CHANGES, clientClock, serverClock);
  const clock = serverNow ?? fallbackClock;

  const held = useMemo(() => new Set(heldSpots), [heldSpots]);

  const ordered = useMemo(() => {
    const copy = [...spots];
    if (sort === "price") {
      // Descending, like the reference board: the contested spots lead.
      copy.sort((a, b) => b.currentPriceCents - a.currentPriceCents || a.x - b.x);
    } else {
      // The car faces right in the photograph, so a high x is nearer the nose.
      copy.sort((a, b) => b.x - a.x);
    }
    return copy;
  }, [spots, sort]);

  const total = totalSpots ?? spots.length;
  const taken = spots.filter((spot) => spot.holder !== null).length;
  const headingId = "spot-list-heading";

  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="max-w-[640px]">
        <p className="eyebrow flex items-center gap-2">
          <span aria-hidden="true" className="live-dot h-1.5 w-1.5 rounded-full bg-live" />
          Live
        </p>

        <h2 id={headingId} className="display-lg mt-4 text-ink">
          The auction, live.
        </h2>
        <p className="lede mt-4">Every spot shows its current top bid.</p>

        <p className="tabular mt-7 text-[15px] text-muted" aria-live="polite" aria-atomic="true">
          {spots.length} of {total} spots · {taken} taken
        </p>

        <p className="mt-3 text-[14px] leading-relaxed text-muted">
          Every spot opens at what the vinyl and its fitting actually cost — artwork setup,
          printed cast vinyl, and the labour to apply it to painted bodywork. Nothing above
          that is asked for at the floor. Prominence is priced by the bidding, not by us.
        </p>
      </div>

      <div className="mt-10 flex items-center justify-between gap-4">
        <span id="spot-sort-label" className="text-[13px] text-faint">
          Sort by
        </span>
        <div
          role="group"
          aria-labelledby="spot-sort-label"
          className="inline-flex rounded-full border border-hairline p-[3px]"
        >
          {SORTS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={sort === option.key}
              onClick={() => setSort(option.key)}
              className={`rounded-full px-3.5 py-1.5 text-[13px] transition-colors duration-200 ${FOCUS_RING} ${
                sort === option.key
                  ? "bg-ink text-canvas"
                  : "text-muted hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <ul className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {ordered.map((spot, position) => (
          <li key={spot.key}>
            <SpotCard
              spot={spot}
              index={position + 1}
              serverNow={clock}
              held={held.has(spot.key)}
              onBid={onBid}
            />
          </li>
        ))}
      </ul>

      {ordered.length === 0 ? (
        <p className="mt-10 text-[15px] text-muted">No spots to show.</p>
      ) : null}
    </section>
  );
}
