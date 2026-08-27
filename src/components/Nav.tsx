"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Section anchors the page is expected to expose. Scrolling itself is native:
 * `scroll-behavior` and `scroll-padding-top` are set in globals.css / layout,
 * which also means `prefers-reduced-motion` is honoured without any JS.
 */
// Nav fragments are root-relative on purpose: a bare "#spots" resolves
// only on the home page and silently does nothing from /terms or /admin.
const LINKS = [
  { href: "/#spots", label: "The car" },
  { href: "/#leaderboard", label: "Leaderboard" },
  { href: "/terms", label: "Terms" },
] as const;

export default function Nav() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Dismissing with the keyboard must not drop focus at the document root.
      triggerRef.current?.focus();
    }

    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return; // its own onClick toggles
      setOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-50 hairline-b bg-canvas/72 backdrop-blur-xl backdrop-saturate-150">
      <nav aria-label="Primary" className="shell-wide flex h-12 items-center justify-between gap-4">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-sm text-[15px] font-semibold tracking-[-0.022em] text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
        >
          <svg
            viewBox="0 0 44 16"
            width="22"
            height="8"
            aria-hidden="true"
            focusable="false"
            fill="currentColor"
            className="text-live"
          >
            <path d="M2 11.4c0-2.2 1.3-3.5 3.4-3.9l6.1-1.1 4.6-3.4c.9-.7 2-1 3.1-1h7.2c1.3 0 2.4.5 3.3 1.4l3.2 3.3 4.6.9c2.3.5 3.5 1.6 3.5 3.7v1.3H2v-1.2z" />
            <circle cx="11.5" cy="12.9" r="2.7" />
            <circle cx="32" cy="12.9" r="2.7" />
          </svg>
          Brand My Datsun
        </Link>

        <ul className="hidden items-center gap-7 md:flex">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className="rounded-sm text-[13px] text-muted transition-colors duration-200 ease-showroom hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-1.5">
          <Link
            href="/#spots"
            className="btn btn-primary btn-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          >
            Get a spot
          </Link>

          <button
            ref={triggerRef}
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((wasOpen) => !wasOpen)}
            className="-mr-2 flex h-9 w-9 items-center justify-center rounded-full text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal md:hidden"
          >
            <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
            <span aria-hidden="true" className="relative block h-3 w-4">
              <span
                className={`absolute left-0 block h-px w-full bg-ink transition-transform duration-300 ease-showroom ${
                  open ? "top-1/2 rotate-45" : "top-0"
                }`}
              />
              <span
                className={`absolute left-0 block h-px w-full bg-ink transition-transform duration-300 ease-showroom ${
                  open ? "top-1/2 -rotate-45" : "top-full"
                }`}
              />
            </span>
          </button>
        </div>
      </nav>

      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        className="hairline-t bg-canvas/95 backdrop-blur-xl md:hidden"
      >
        <ul className="shell-wide flex flex-col py-2">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                onClick={() => setOpen(false)}
                className="block rounded-sm py-2.5 text-[15px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}
