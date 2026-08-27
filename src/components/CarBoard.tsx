"use client";

import Image from "next/image";
import { useCallback, useMemo, useRef, type KeyboardEvent } from "react";
import SpotHotspot from "@/components/SpotHotspot";
import { CAR } from "@/config/car";
import { formatMoney } from "@/lib/money";
import type { SpotView } from "@/lib/types";

interface CarBoardProps {
  spots: SpotView[];
  view: "live" | "final";
  onSelect: (spotKey: string) => void;
  selectedKey?: string | null;
  className?: string;
}

const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

/**
 * The car and its eleven biddable regions.
 *
 * The container is locked to the photograph's aspect ratio, which is the whole
 * trick: every spot is then positioned in the same percentages the photo was
 * measured in, so the overlay stays welded to the bodywork from 320px to 4K
 * without a resize listener or a pixel conversion anywhere.
 */
export default function CarBoard({
  spots,
  view,
  onSelect,
  selectedKey = null,
  className = "",
}: CarBoardProps) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const registerRef = useCallback((spotKey: string, node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(spotKey, node);
    else buttons.current.delete(spotKey);
  }, []);

  // DOM order is left-to-right across the car, so tabbing walks the bodywork
  // from tailgate to bonnet rather than in whatever order the API sent.
  const acrossCar = useMemo(
    () => [...spots].sort((a, b) => a.x + a.w / 2 - (b.x + b.w / 2)),
    [spots],
  );
  const downCar = useMemo(
    () => [...spots].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2)).map((s) => s.key),
    [spots],
  );

  const selected = selectedKey ? spots.find((s) => s.key === selectedKey) ?? null : null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!NAV_KEYS.has(event.key)) return;

    const origin = (event.target as HTMLElement).closest<HTMLElement>("[data-spot-key]");
    const from = origin?.dataset.spotKey;
    if (!from) return;

    // Left/right walks the car's length, up/down its height — the two axes a
    // sighted user is actually looking along. Spots absent from the DOM (the
    // final view only mounts the ones wearing a logo) drop out of both orders.
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const order = (vertical ? downCar : acrossCar.map((s) => s.key)).filter((key) =>
      buttons.current.has(key),
    );
    const index = order.indexOf(from);
    if (index === -1) return;

    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const next =
      event.key === "Home"
        ? order[0]
        : event.key === "End"
          ? order[order.length - 1]
          : order[(index + step + order.length) % order.length];

    buttons.current.get(next)?.focus();
    event.preventDefault();
  }

  return (
    <div
      className={`relative w-full select-none ${className}`}
      style={{ aspectRatio: `${CAR.photoWidth} / ${CAR.photoHeight}` }}
    >
      <Image
        src={CAR.photo}
        alt={`${CAR.name} in profile — ${CAR.subtitle}`}
        fill
        priority
        sizes="(max-width: 768px) 100vw, (max-width: 1440px) 92vw, 1320px"
        draggable={false}
        className="object-contain"
      />

      <div
        role="group"
        aria-label={
          view === "live"
            ? "Advertising spots on the car — select one to bid"
            : "Approved logos on the car"
        }
        onKeyDown={handleKeyDown}
        className="absolute inset-0"
      >
        {acrossCar.map((spot) => (
          <SpotHotspot
            key={spot.key}
            spot={spot}
            view={view}
            selected={spot.key === selectedKey}
            onSelect={onSelect}
            registerRef={registerRef}
          />
        ))}
      </div>

      {/* One quiet live region for the spot the visitor is actually looking at.
          Eleven of them — one per chip — would announce the whole board every
          time the stream ticks, which is unusable. */}
      <p aria-live="polite" className="sr-only">
        {selected ? `${selected.name}: ${formatMoney(selected.currentPriceCents)}` : ""}
      </p>
    </div>
  );
}
