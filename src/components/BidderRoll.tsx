"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { linkLabel } from "@/lib/link";
import { formatMoney } from "@/lib/money";
import type { RollEntry } from "@/lib/types";

/**
 * Everyone who has ever paid, biggest bid first.
 *
 * The spot table above answers "what can I still win". This answers "who has
 * put money into this car", which is a different list: a bid that was outbid is
 * not refunded, so it stays here permanently. Nobody drops off the roll.
 */

export interface BidderRollProps {
  /**
   * Changes whenever money has moved. The roll is fetched separately from the
   * board, so this is what tells it to read again without putting the whole
   * history of the auction on the two-second state stream.
   */
  revision: number;
  className?: string;
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

/** How many rows a read brings back. The server clamps anything larger. */
const PAGE = 25;

/** One page of the roll, as the endpoint returns it. */
interface RollPage {
  entries: RollEntry[];
  total: number;
  hasMore: boolean;
  totalPaidCents: number;
}

/** rank, bidder, spot, amount */
const ROW =
  "grid grid-cols-[2rem_1fr_auto] items-center gap-x-4 gap-y-1 " +
  "md:grid-cols-[2.5rem_minmax(0,1.6fr)_minmax(0,1fr)_8rem]";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return "?";
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export default function BidderRoll({ revision, className = "" }: BidderRollProps) {
  const [entries, setEntries] = useState<RollEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPaidCents, setTotalPaidCents] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /** Nothing is written to state before the fetch resolves, which keeps the
   *  effect below a subscription rather than a synchronous render cascade. */
  const read = useCallback(async (offset: number, limit: number): Promise<RollPage | null> => {
    try {
      const response = await fetch(`/api/auction/roll?offset=${offset}&limit=${limit}`, {
        cache: "no-store",
      });
      if (!response.ok) return null;
      return (await response.json()) as RollPage;
    } catch {
      return null;
    }
  }, []);

  /**
   * How many rows are on screen.
   *
   * Written by the two loaders rather than mirrored from `entries` during
   * render, so neither of them has to depend on the list it is replacing. A
   * dependency on the list would rebuild `refresh` on every page and re-fire
   * the effect below, which would page forever.
   */
  const shownRef = useRef(0);

  /**
   * Re-read from the top, keeping however many rows are already on screen.
   *
   * A settled bid can land anywhere in an ordering by amount, so refreshing
   * only the first page would leave a stale tail below a fresh head. Asking for
   * what is already shown keeps the whole visible list consistent.
   */
  const refresh = useCallback(async () => {
    const page = await read(0, Math.max(PAGE, Math.min(shownRef.current, 100)));

    if (page === null) {
      setFailed(true);
      return;
    }
    shownRef.current = page.entries.length;
    setFailed(false);
    setEntries(page.entries);
    setTotal(page.total);
    setTotalPaidCents(page.totalPaidCents);
    setHasMore(page.hasMore);
  }, [read]);

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    const page = await read(shownRef.current, PAGE);
    setLoadingMore(false);

    if (page === null) {
      setFailed(true);
      return;
    }
    shownRef.current += page.entries.length;
    setFailed(false);
    setEntries((current) => [...(current ?? []), ...page.entries]);
    setTotal(page.total);
    setTotalPaidCents(page.totalPaidCents);
    setHasMore(page.hasMore);
  }, [read]);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
    // `revision` moves when a bid settles, which is the only thing that can
    // change the roll.
  }, [refresh, revision]);

  const headingId = "bidders-heading";

  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id={headingId} className="display-md text-ink">
          Bidders
        </h2>
        {entries && entries.length > 0 ? (
          <p className="tabular text-[14px] text-muted">
            {total} bid{total === 1 ? "" : "s"} · {formatMoney(totalPaidCents)} paid
          </p>
        ) : null}
      </div>

      <p className="mt-3 max-w-[62ch] text-[14px] leading-[1.55] text-muted">
        Every bid ever placed on this car, largest first. Being outbid does not take you off this
        list, because being outbid does not get you your money back. Neither does bidding under
        what a panel is going for: that money is kept and counted here, it just does not put your
        logo on the car.
      </p>

      {entries === null ? (
        <p className="mt-8 text-[14px] text-muted">
          {failed ? "The bidders list is unavailable right now." : "Loading…"}
        </p>
      ) : entries.length === 0 ? (
        <p className="mt-8 text-[14px] text-muted">
          Nobody has bid yet. The first name on this list is still available.
        </p>
      ) : (
        <>
          <div
            aria-hidden="true"
            className={`${ROW} hairline-b mt-8 hidden pb-3 text-[11px] uppercase tracking-[0.08em] text-faint md:grid`}
          >
            <span>#</span>
            <span>Bidder</span>
            <span>Spot</span>
            <span className="text-right">Paid</span>
          </div>

          <ul>
            {entries.map((entry, index) => {
              const rank = index + 1;
              return (
                <li key={entry.bidId}>
                  <article className={`${ROW} hairline-b py-4`}>
                    <span
                      className={`tabular text-[15px] font-semibold ${
                        rank <= 3 ? "text-ink" : "text-faint"
                      }`}
                    >
                      <span className="sr-only">Rank </span>
                      {rank}
                    </span>

                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-haze">
                        {entry.logoUrl ? (
                          // Approved artwork may be SVG, which the image
                          // optimiser refuses by default, so the stored bytes
                          // are served exactly as they were uploaded.
                          <Image
                            src={entry.logoUrl}
                            alt=""
                            width={36}
                            height={36}
                            unoptimized
                            className="h-7 w-7 object-contain"
                          />
                        ) : (
                          <span aria-hidden="true" className="text-[11px] font-medium text-faint">
                            {initialsOf(entry.displayName)}
                          </span>
                        )}
                      </span>

                      <span className="min-w-0">
                        <span className="block truncate text-[15px] font-medium text-ink">
                          {entry.displayName}
                          {entry.holding ? (
                            <span className="ml-2 align-middle text-[11px] font-medium uppercase tracking-[0.06em] text-good">
                              Holding
                            </span>
                          ) : null}
                        </span>
                        {entry.link ? (
                          <a
                            href={entry.link}
                            target="_blank"
                            // A bidder's own address is not a link we vouch for,
                            // and `noopener` is what stops the opened page
                            // reaching back through window.opener.
                            rel="noopener noreferrer nofollow ugc"
                            className={`block truncate rounded-sm text-[12px] text-signal hover:underline ${FOCUS_RING}`}
                          >
                            {linkLabel(entry.link)}
                          </a>
                        ) : null}
                      </span>
                    </div>

                    <p className="col-start-2 truncate text-[13px] text-muted md:col-start-auto">
                      {entry.spotName}
                    </p>

                    <p className="tabular col-start-3 row-start-1 text-right text-[17px] font-semibold tracking-[-0.02em] text-ink md:col-start-auto md:row-start-auto">
                      <span className="sr-only">Paid </span>
                      {formatMoney(entry.amountCents)}
                    </p>
                  </article>
                </li>
              );
            })}
          </ul>

          {hasMore ? (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className={`btn btn-secondary btn-md ${FOCUS_RING}`}
              >
                {loadingMore
                  ? "Loading…"
                  : `Show ${Math.min(PAGE, total - entries.length)} more`}
              </button>
            </div>
          ) : null}

          <p className="mt-6 text-center text-[12px] text-faint" aria-live="polite">
            Showing {entries.length} of {total}
          </p>
        </>
      )}
    </section>
  );
}
