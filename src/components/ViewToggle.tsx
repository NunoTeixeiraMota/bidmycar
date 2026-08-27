"use client";

import { useRef, type KeyboardEvent } from "react";

export type CarView = "live" | "final";

interface ViewToggleProps {
  value: CarView;
  onChange: (value: CarView) => void;
  className?: string;
}

const OPTIONS: ReadonlyArray<{ value: CarView; label: string }> = [
  { value: "live", label: "Live auction" },
  { value: "final", label: "Final look" },
];

/**
 * Segmented control over the two ways of looking at the car.
 *
 * Built as a real radiogroup rather than two buttons: the two views are
 * mutually exclusive states of one thing, so a screen reader should hear
 * "1 of 2 selected", and the arrow keys, not tab, should move between them.
 * Roving tabindex keeps the whole control a single tab stop.
 */
export default function ViewToggle({ value, onChange, className = "" }: ViewToggleProps) {
  const refs = useRef(new Map<CarView, HTMLButtonElement>());
  const activeIndex = OPTIONS.findIndex((option) => option.value === value);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let nextIndex: number | null = null;

    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        nextIndex = (activeIndex + 1) % OPTIONS.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        nextIndex = (activeIndex - 1 + OPTIONS.length) % OPTIONS.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = OPTIONS.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const next = OPTIONS[nextIndex];
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Car view"
      onKeyDown={handleKeyDown}
      className={`relative grid grid-cols-2 rounded-full bg-slate p-1 ${className}`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%_-_0.25rem)] rounded-full bg-canvas shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-transform duration-300 ease-showroom"
        style={{ transform: activeIndex === 1 ? "translateX(100%)" : "none" }}
      />

      {OPTIONS.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) refs.current.set(option.value, node);
              else refs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={`relative z-10 cursor-pointer whitespace-nowrap rounded-full px-5 py-2 text-[13px] font-medium transition-colors duration-200 ease-showroom focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal ${
              checked ? "text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
