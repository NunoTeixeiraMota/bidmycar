"use client";

import { useEffect, useRef, useState } from "react";

interface CountdownProps {
  /** Epoch ms when this clock stops. */
  closesAt: number;
  /** The server's clock at render time, from AuctionState. */
  serverNow: number;
  /** One line — "12d 18h 23m" — instead of the labelled d/h/m/s block. */
  compact?: boolean;
  className?: string;
}

/** Under this the countdown turns red: last call to bid. */
const URGENT_MS = 5 * 60 * 1000;

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export default function Countdown({
  closesAt,
  serverNow,
  compact = false,
  className = "",
}: CountdownProps) {
  // Seeded from the props so the first client render matches the server's HTML.
  const [remaining, setRemaining] = useState(() => Math.max(0, closesAt - serverNow));

  // A browser clock can be minutes out, so the countdown runs on the server's
  // timeline: sample the offset once, at mount, and tick against that. Later
  // `serverNow` values (this re-renders every couple of seconds off the state
  // stream) deliberately do not resample — that would restart the ticker.
  const serverNowAtMount = useRef(serverNow);

  useEffect(() => {
    const offset = serverNowAtMount.current - Date.now();
    const tick = () => setRemaining(Math.max(0, closesAt - (Date.now() + offset)));

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [closesAt]);

  const closed = remaining <= 0;
  const urgent = !closed && remaining < URGENT_MS;

  const totalSeconds = Math.floor(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // Deliberately seconds-free: the live region's text then only changes on a
  // minute boundary, so a screen reader announces once a minute instead of
  // once a second, which is unusable.
  const announcement = closed
    ? "Bidding closed"
    : days > 0
      ? `${days} days ${hours} hours ${minutes} minutes remaining`
      : hours > 0
        ? `${hours} hours ${minutes} minutes remaining`
        : `${minutes} minutes remaining`;

  const tone = closed ? "text-faint" : urgent ? "text-live" : "text-ink";

  return (
    <div className={className}>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>

      {compact ? (
        <span aria-hidden="true" className={`tabular whitespace-nowrap ${tone}`}>
          {closed
            ? "Closed"
            : days > 0
              ? `${days}d ${hours}h ${minutes}m`
              : hours > 0
                ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
                : `${minutes}m ${pad(seconds)}s`}
        </span>
      ) : closed ? (
        <span
          aria-hidden="true"
          className="text-[1.75rem] font-semibold tracking-[-0.02em] text-faint"
        >
          Closed
        </span>
      ) : (
        <div aria-hidden="true" className="flex items-start gap-6">
          {[
            { label: "Days", value: String(days) },
            { label: "Hours", value: pad(hours) },
            { label: "Minutes", value: pad(minutes) },
            { label: "Seconds", value: pad(seconds) },
          ].map((unit) => (
            <div key={unit.label}>
              <div className={`tabular text-[1.75rem] font-semibold tracking-[-0.02em] ${tone}`}>
                {unit.value}
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-[0.08em] text-faint">
                {unit.label}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
