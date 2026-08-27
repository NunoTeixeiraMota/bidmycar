"use client";

import Image from "next/image";
import { formatMoney } from "@/lib/money";
import type { SpotView } from "@/lib/types";

export interface SpotHotspotProps {
  spot: SpotView;
  view: "live" | "final";
  selected: boolean;
  onSelect: (spotKey: string) => void;
  /** CarBoard keeps the button nodes so arrow keys can move focus between spots. */
  registerRef: (spotKey: string, node: HTMLButtonElement | null) => void;
}

/**
 * Below this height (percent of the photo) the spot box is thinner than a price
 * chip, so the chip sits above the outline instead of inside it. Above is the
 * only free side: everything underneath the short spots — the rocker banner,
 * the lower wing, the lower rear quarter — is itself a spot.
 */
const CHIP_FITS_INSIDE_H = 4.5;

/** Neutral stand-in while a human reviews an upload. Never the file itself. */
const REVIEW_HATCH =
  "repeating-linear-gradient(45deg, rgba(255,255,255,0.94) 0 5px, rgba(210,210,215,0.94) 5px 10px)";

function round(cm: number): number {
  return Math.round(cm);
}

/**
 * One biddable region of bodywork: its geometry comes straight from the spot's
 * own percentages, so it tracks the photo at every viewport width without a
 * single pixel measurement.
 */
export default function SpotHotspot({
  spot,
  view,
  selected,
  onSelect,
  registerRef,
}: SpotHotspotProps) {
  const holder = spot.holder;
  const logoUrl = holder?.logoUrl ?? null;
  const pending = holder?.artworkPending === true;
  const closed = spot.status === "closed";
  const ellipse = spot.shape === "ellipse";
  const price = formatMoney(spot.currentPriceCents);
  const dims = `${round(spot.widthCm)} × ${round(spot.heightCm)} cm`;

  // The final view is a photograph of a finished car, not a UI: a spot nobody
  // won, or whose artwork is still in review, simply is not on the car.
  if (view === "final" && !logoUrl) return null;

  const spoken = `${round(spot.widthCm)} by ${round(spot.heightCm)} centimetres`;
  const label = closed
    ? holder
      ? `${spot.name}, ${spoken}, closed — won by ${holder.displayName} at ${price}`
      : `${spot.name}, ${spoken}, closed with no bids`
    : holder
      ? `Bid on the ${spot.name.toLowerCase()}, ${spoken}, held by ${holder.displayName} at ${price}`
      : `Bid on the ${spot.name.toLowerCase()}, ${spoken}, currently ${price}`;

  const radius = ellipse ? "50%" : "3px";
  // A chip inside the box would sit on top of the holder's logo, so only an
  // empty spot that is tall enough gets one; everything else labels above.
  const chipInside = spot.h >= CHIP_FITS_INSIDE_H && !logoUrl && !pending;

  let plateSkin: string;
  if (view === "final") {
    plateSkin = "";
  } else if (closed) {
    plateSkin = "border border-hairline bg-white/50";
  } else if (holder) {
    // Only a hairline and the faintest wash. An opaque plate here reads as a
    // white sticker card floating over the car rather than a decal ON it, and
    // it hides the paint the buyer is actually paying to sit on.
    plateSkin =
      "border border-white/95 bg-white/10 shadow-[0_1px_6px_rgba(0,0,0,0.22)] group-hover:bg-white/25";
  } else {
    plateSkin =
      "border border-dashed border-white/90 bg-white/12 shadow-[0_0_0_1px_rgba(0,0,0,0.14)] group-hover:border-solid group-hover:bg-white/35";
  }

  return (
    <button
      type="button"
      ref={(node) => {
        registerRef(spot.key, node);
      }}
      data-spot-key={spot.key}
      aria-label={label}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(spot.key)}
      style={{
        left: `${spot.x}%`,
        top: `${spot.y}%`,
        width: `${spot.w}%`,
        height: `${spot.h}%`,
        borderRadius: radius,
      }}
      className="group absolute z-10 cursor-pointer focus:outline-none focus-visible:z-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-signal hover:z-30"
    >
      <span
        style={{ borderRadius: radius }}
        className={`absolute inset-0 overflow-hidden transition-all duration-200 ease-showroom ${plateSkin} ${
          selected ? "ring-2 ring-signal" : ""
        }`}
      >
        {logoUrl ? (
          <Image
            src={logoUrl}
            alt=""
            fill
            sizes="20vw"
            // The optimiser refuses SVG unless dangerouslyAllowSVG is on, and an
            // approved logo may well be one — so these bytes are served as
            // uploaded. object-contain is what keeps any aspect ratio honest.
            unoptimized
            draggable={false}
            // The inset MUST be absolute, not a percentage: CSS resolves
            // percentage padding against the box's WIDTH on all four sides, so
            // on a long thin spot like the rocker banner (116 x 8 cm) a 6%
            // inset exceeds the height and collapses the logo to nothing.
            className={`object-contain ${
              view === "final"
                ? "p-0 [filter:drop-shadow(0_1px_1px_rgba(0,0,0,0.28))]"
                : "p-[3px]"
            }`}
          />
        ) : pending ? (
          <span aria-hidden="true" className="absolute inset-0" style={{ backgroundImage: REVIEW_HATCH }} />
        ) : null}
      </span>

      {view === "live" ? (
        <span
          aria-hidden="true"
          className={`tabular pointer-events-none absolute left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-full bg-canvas px-1.5 py-px text-[11px] font-medium leading-[1.35] text-ink shadow-[0_1px_4px_rgba(0,0,0,0.3)] sm:block ${
            chipInside ? "bottom-[6%]" : "bottom-full mb-1"
          }`}
        >
          {price}
        </span>
      ) : null}

      {/* Repeats what the accessible name already says, so it is hidden from
          assistive tech; it exists for the pointer and the sighted keyboard user. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute bottom-full left-1/2 hidden w-max max-w-[15rem] -translate-x-1/2 rounded-lg bg-graphite px-3 py-2 text-left opacity-0 shadow-[0_6px_20px_rgba(0,0,0,0.28)] transition-opacity duration-200 ease-showroom group-hover:opacity-100 group-focus-visible:opacity-100 sm:block ${
          view === "live" && !chipInside ? "mb-7" : "mb-2"
        }`}
      >
        <span className="block text-[13px] font-medium leading-snug text-white">{spot.name}</span>
        <span className="tabular block text-[11px] leading-snug text-white/60">{dims}</span>
        <span className="tabular block text-[12px] leading-snug text-white/90">
          {closed ? "Closed · " : ""}
          {price}
          {holder ? ` · ${holder.displayName}` : ""}
          {pending ? " · artwork under review" : ""}
        </span>
      </span>
    </button>
  );
}
