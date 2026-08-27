"use client";

import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
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
  const [failed, setFailed] = useState(false);

  /** Nothing is written to state before the fetch resolves, which keeps the
   *  effect below a subscription rather than a synchronous render cascade. */
  const load = useCallback(async () => {
    let next: RollEntry[] | null = null;
    try {
      const response = await fetch("/api/auction/roll", { cache: "no-store" });
      if (response.ok) next = ((await response.json()) as { entries: RollEntry[] }).entries;
    } catch {
      next = null;
    }

    if (next === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setEntries(next);
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
    // `revision` moves when a bid settles, which is the only thing that can
    // change the roll.
  }, [load, revision]);

  const headingId = "bidders-heading";
  const total = entries?.reduce((sum, entry) => sum + entry.amountCents, 0) ?? 0;

  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id={headingId} className="display-md text-ink">
          Bidders
        </h2>
        {entries && entries.length > 0 ? (
          <p className="tabular text-[14px] text-muted">
            {entries.length} bid{entries.length === 1 ? "" : "s"} · {formatMoney(total)} paid
          </p>
        ) : null}
      </div>

      <p className="mt-3 max-w-[60ch] text-[14px] leading-[1.55] text-muted">
        Every bid ever placed on this car, largest first. Being outbid does not take you off this
        list, because being outbid does not get you your money back.
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
        </>
      )}
    </section>
  );
}
