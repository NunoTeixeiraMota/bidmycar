"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import BidDialog from "@/components/BidDialog";
import CarBoard from "@/components/CarBoard";
import Countdown from "@/components/Countdown";
import RaisedBar from "@/components/RaisedBar";
import SpotList from "@/components/SpotList";
import ViewToggle, { type CarView } from "@/components/ViewToggle";
import useAuctionState from "@/hooks/useAuctionState";
import type { AuctionState } from "@/lib/types";

/**
 * The live half of the home page: one state subscription, one selection, one
 * dialog. Everything below it is presentational, which is why the car and the
 * list can be kept in step without either knowing the other exists.
 */

export interface AuctionBoardProps {
  initialState: AuctionState;
}

interface Me {
  bidder: { id: string; displayName: string; email: string } | null;
  heldSpots: string[];
}

const EMPTY_ME: Me = { bidder: null, heldSpots: [] };

/** SpotCard labels its <article> with the id of its own heading. That is the
 *  only handle the list gives us, so it is how a card is found and how a click
 *  inside one is traced back to a spot. */
const CARD_SELECTOR = "article[aria-labelledby^='spot-']";
const CARD_LABEL = /^spot-(.+)-name$/;

function cardHeadingId(spotKey: string): string {
  return `spot-${spotKey}-name`;
}

function keyFromCard(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  const card = target.closest<HTMLElement>(CARD_SELECTOR);
  const match = card?.getAttribute("aria-labelledby")?.match(CARD_LABEL);
  return match ? match[1] : null;
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
      // Identity is a convenience here — a prefilled form and a "you hold this"
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

  // Selecting on the car brings the matching card to the middle of the screen;
  // the reverse direction only highlights, because scrolling the page under
  // someone who just clicked a card is disorienting.
  const selectFromCar = useCallback(
    (spotKey: string) => {
      setSelectedKey(spotKey);

      // A hotspot announces itself as "Bid on the door panel", so a live spot
      // opens the dialog. A closed one, or the finished-car view, only takes
      // you to its card — there is nothing left to bid on.
      const spot = state.spots.find((candidate) => candidate.key === spotKey);
      const bidding = view === "live" && spot !== undefined && spot.status !== "closed";
      if (bidding) setBiddingKey(spotKey);

      const heading = document.getElementById(cardHeadingId(spotKey));
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      // A modal dialog locks the scroll behind it, which cuts a smooth scroll
      // off part-way; jump instead so the card is waiting when it closes.
      heading?.scrollIntoView({
        behavior: bidding || reduced ? "auto" : "smooth",
        block: "center",
      });
    },
    [state.spots, view],
  );

  const selectFromList = useCallback((event: SyntheticEvent) => {
    const spotKey = keyFromCard(event.target);
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
      <section
        id="spots"
        aria-labelledby="spots-heading"
        className="section hairline-b scroll-mt-16 bg-haze"
      >
        <div className="shell-wide">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[420px]">
              <h2 id="spots-heading" className="display-md text-ink">
                {state.allClosed ? "Bidding has closed." : "Eleven spots. Eleven clocks."}
              </h2>
              <p className="mt-3 text-[15px] leading-[1.55] text-muted">
                {state.allClosed
                  ? "Every spot has been decided. The logos below are the ones going on the car."
                  : "The clock is the next panel to close — every one of them has its own. Whoever is holding a panel when its clock stops gets it."}
              </p>
              <RaisedBar
                className="mt-8"
                totalRaisedCents={state.totalRaisedCents}
                goalCents={state.goalCents}
                goalPercent={state.goalPercent}
              />
            </div>

            <div className="lg:text-right">
              <p className="flex items-center gap-2 text-[12px] uppercase tracking-[0.08em] text-faint lg:justify-end">
                <span
                  aria-hidden="true"
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    state.allClosed ? "bg-faint" : `bg-live ${connected ? "live-dot" : ""}`
                  }`}
                />
                {state.allClosed ? "Closed" : "First spot closes in"}
              </p>
              <Countdown
                className="mt-4 lg:flex lg:justify-end"
                closesAt={state.closesAt}
                serverNow={state.serverNow}
              />
            </div>
          </div>

          {error ? (
            <p role="status" className="mt-8 text-[13px] text-live">
              {error}
            </p>
          ) : null}

          <div className="mt-14 flex justify-center">
            <ViewToggle value={view} onChange={setView} className="w-[300px]" />
          </div>

          <CarBoard
            className="mt-8"
            spots={state.spots}
            view={view}
            onSelect={selectFromCar}
            selectedKey={selectedKey}
          />

          <p className="mt-4 text-center text-[13px] text-faint">
            {view === "live"
              ? "Tap a panel to bid on it, or pick one from the list below."
              : "The car as it will look — approved logos only."}
          </p>
        </div>
      </section>

      <section className="section">
        <div className="shell-wide">
          {/* Capture rather than bubble: the card's own button handles the click
              first, and this only needs to know which card it happened in. */}
          <div onPointerDownCapture={selectFromList} onFocusCapture={selectFromList}>
            <SpotList
              spots={state.spots}
              onBid={openBid}
              heldSpots={me.heldSpots}
              serverNow={state.serverNow}
              totalSpots={state.spotsTotal}
            />
          </div>
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
