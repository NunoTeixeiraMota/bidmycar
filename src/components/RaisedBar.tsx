"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";

interface RaisedBarProps {
  totalRaisedCents: number;
  goalCents: number;
  /** Truthful percentage of the goal; may exceed 100. */
  goalPercent: number;
  className?: string;
}

export default function RaisedBar({
  totalRaisedCents,
  goalCents,
  goalPercent,
  className = "",
}: RaisedBarProps) {
  const percent = Number.isFinite(goalPercent) ? Math.max(0, goalPercent) : 0;
  const passed = percent >= 100;
  // The bar caps at full; the label above it does not, because "135%" is the
  // interesting number and clamping it would hide the result.
  const filled = Math.min(percent, 100);

  const [width, setWidth] = useState(0);
  useEffect(() => {
    // One frame at zero width gives the transition something to run from,
    // so the bar sweeps in on mount instead of appearing already full.
    const frame = requestAnimationFrame(() => setWidth(filled));
    return () => cancelAnimationFrame(frame);
  }, [filled]);

  return (
    <div className={className}>
      <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1" aria-live="polite">
        <span className="tabular display-md text-good">{formatMoney(totalRaisedCents)}</span>
        <span className="text-[15px] text-muted">raised</span>
        <span className="text-[13px] text-faint">
          {passed ? `goal passed · ${Math.round(percent)}%` : `of ${formatMoney(goalCents)} goal`}
        </span>
      </p>

      <div
        role="progressbar"
        aria-label="Progress towards the funding goal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(filled)}
        aria-valuetext={`${formatMoney(totalRaisedCents)} of ${formatMoney(goalCents)}, ${Math.round(percent)} percent`}
        className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate"
      >
        <div
          className="h-full rounded-full bg-good transition-[width] duration-1000 ease-showroom"
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}
