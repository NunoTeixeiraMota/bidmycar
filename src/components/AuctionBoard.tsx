"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import BidDialog from "@/components/BidDialog";
import BidderRoll from "@/components/BidderRoll";
import CarBoard from "@/components/CarBoard";
import Leaderboard from "@/components/Leaderboard";
import ViewToggle, { type CarView } from "@/components/ViewToggle";
import useAuctionState from "@/hooks/useAuctionState";
import type { AuctionState } from "@/lib/types";

/**
 * The whole page, live: one state subscription, one selection, one dialog.
 * The car sits on top and the leaderboard directly under it, so the thing you
 * click and the thing you read are never more than a scroll apart.
 */

export interface AuctionBoardProps {
  initialState: AuctionState;
}

interface Me {
  bidder: { id: string; displayName: string; email: string; link: string | null } | null;
  heldSpots: string[];
}

const EMPTY_ME: Me = { bidder: null, heldSpots: [] };

/** Every leaderboard row carries its spot key, which is how a click inside one
 *  is traced back to a spot and how a card is found to be scrolled to. */
const ROW_SELECTOR = "[data-spot-key]";

function rowHeadingId(spotKey: string): string {
  return `spot-${spotKey}-name`;
}

function keyFromRow(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  const row = target.closest<HTMLElement>(ROW_SELECTOR);
  return row?.dataset.spotKey ?? null;
}

export default function AuctionBoard({ initialState }: AuctionBoardProps) {
  const { state, connected, error, refresh } = useAuctionState(initialState);

  const [view, setView] = useState<CarView>("live");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [biddingKey, setBiddingKey] = useState<string | null>(null);
  const [me, setMe] = useState<Me>(EMPTY_ME);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadMe = useCallback(async () => {
    try {
      const response = await fetch("/api/me", { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()) as Me;
      if (!alive.current) return;
      setMe({ bidder: next.bidder ?? null, heldSpots: next.heldSpots ?? [] });
    } catch {
      // Identity is a convenience here: a prefilled form and a "you hold this"
      // badge. Failing to read it must not disturb the board.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadMe();
    })();
  }, [loadMe]);

  const biddingSpot = useMemo(
    () => (biddingKey ? (state.spots.find((spot) => spot.key === biddingKey) ?? null) : null),
    [biddingKey, state.spots],
  );

  // Selecting on the car brings the matching row to the middle of the screen;
  // the reverse direction only highlights, because scrolling the page under
  // someone who just clicked a row is disorienting.
  const selectFromCar = useCallback(
    (spotKey: string) => {
      setSelectedKey(spotKey);

      // A hotspot announces itself as "Bid on the door panel", so a live spot
      // opens the dialog. A closed one, or the finished-car view, only takes
      // you to its row: there is nothing left to bid on.
      const spot = state.spots.find((candidate) => candidate.key === spotKey);
      const bidding = view === "live" && spot !== undefined && spot.status !== "closed";
      if (bidding) setBiddingKey(spotKey);

      const heading = document.getElementById(rowHeadingId(spotKey));
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      // A modal dialog locks the scroll behind it, which cuts a smooth scroll
      // off part-way; jump instead so the row is waiting when it closes.
      heading?.scrollIntoView({
        behavior: bidding || reduced ? "auto" : "smooth",
        block: "center",
      });
    },
    [state.spots, view],
  );

  const selectFromList = useCallback((event: SyntheticEvent) => {
    const spotKey = keyFromRow(event.target);
    if (spotKey) setSelectedKey(spotKey);
  }, []);

  const openBid = useCallback((spotKey: string) => {
    setSelectedKey(spotKey);
    setBiddingKey(spotKey);
  }, []);

  const afterBid = useCallback(async () => {
    await Promise.all([refresh(), loadMe()]);
  }, [refresh, loadMe]);

  return (
    <>
      <section id="spots" aria-label="The car" className="scroll-mt-16 pb-10">
        <div className="shell-wide">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <ViewToggle value={view} onChange={setView} className="w-[300px]" />

            <p className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-faint">
              <span
                aria-hidden="true"
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  state.allClosed ? "bg-faint" : `bg-live ${connected ? "live-dot" : ""}`
                }`}
              />
              {state.allClosed ? "Closed" : "Live"}
            </p>
          </div>

          {error ? (
            <p role="status" className="mt-6 text-[13px] text-live">
              {error}
            </p>
          ) : null}

          <CarBoard
            className="mt-6"
            spots={state.spots}
            view={view}
            onSelect={selectFromCar}
            selectedKey={selectedKey}
          />

          <p className="mt-3 text-center text-[13px] text-faint">
            {view === "live"
              ? "Tap a panel to bid on it, or pick one from the leaderboard."
              : "The car as it will look. Approved logos only."}
          </p>
        </div>
      </section>

      <section id="leaderboard" className="scroll-mt-16 pb-24">
        <div className="shell-wide">
          {/* Capture rather than bubble: the row's own button handles the click
              first, and this only needs to know which row it happened in. */}
          <div onPointerDownCapture={selectFromList} onFocusCapture={selectFromList}>
            <Leaderboard spots={state.spots} onBid={openBid} heldSpots={me.heldSpots} />
          </div>

          {/* Total taken only moves when a bid settles, which is exactly when
              the roll has a new row to show. */}
          <BidderRoll className="mt-20" revision={state.totalRaisedCents} />
        </div>
      </section>

      <BidDialog
        spot={biddingSpot}
        onClose={() => setBiddingKey(null)}
        holding={biddingKey ? me.heldSpots.includes(biddingKey) : false}
        bidder={me.bidder}
        serverNow={state.serverNow}
        onPlaced={() => void afterBid()}
      />
    </>
  );
}
