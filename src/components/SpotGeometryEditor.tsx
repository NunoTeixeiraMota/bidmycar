"use client";

import Image from "next/image";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { CAR } from "@/config/car";
import { formatMoney } from "@/lib/money";

/**
 * The spots on the car: where they are, what they are called, and which ones
 * exist at all.
 *
 * Everything positional here is a percentage of the photograph, never a pixel,
 * which is the same contract CarBoard renders under. That is what lets the
 * editor and the public board agree at any width without a resize listener:
 * drag maths converts pointer pixels into percentages once, on the way in, and
 * nothing downstream ever sees a pixel again.
 *
 * Moving is batched behind Save, because a drag would otherwise be a request
 * per frame. Renaming, adding and deleting are structural and go to the server
 * as they happen, so the two can never be half-applied against each other.
 */

export interface SpotGeometryEditorProps {
  /** Sends an admin request with the console's token attached. */
  call: (path: string, init?: RequestInit) => Promise<unknown | null>;
}

type Difficulty = "flat" | "glass" | "mild" | "curved";

/** One spot as the admin API reports it. */
interface Box {
  key: string;
  name: string;
  panel: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: "rect" | "ellipse";
  difficulty: Difficulty;
  overridden: boolean;
  floorPriceCents: number;
  widthCm: number;
  heightCm: number;
  productionCostCents: number;
  bidCount: number;
  deletable: boolean;
}

/** Which part of a box a drag is holding. "move" is the body. */
type Grip = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

interface Drag {
  key: string;
  grip: Grip;
  /** Pointer position when the drag started, in percentages. */
  originX: number;
  originY: number;
  /** The box as it was before this drag, so every frame is applied to the
   *  original rather than compounding rounding on the previous frame. */
  start: Box;
}

const MIN_SIDE = 0.5;
const NUDGE = 0.2;
const NUDGE_COARSE = 2;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

const DIFFICULTIES: ReadonlyArray<{ value: Difficulty; label: string }> = [
  { value: "flat", label: "Flat" },
  { value: "glass", label: "Glass" },
  { value: "mild", label: "Mild curve" },
  { value: "curved", label: "Compound curve" },
];

/** Handles, and which edges each one drives. */
const HANDLES: ReadonlyArray<{ grip: Grip; label: string; className: string }> = [
  { grip: "nw", label: "top left", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize" },
  { grip: "n", label: "top", className: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize" },
  { grip: "ne", label: "top right", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize" },
  { grip: "w", label: "left", className: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
  { grip: "e", label: "right", className: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize" },
  { grip: "sw", label: "bottom left", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize" },
  { grip: "s", label: "bottom", className: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize" },
  { grip: "se", label: "bottom right", className: "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize" },
];

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function sameGeometry(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.shape === b.shape;
}

/** The geometry half of a box, which a server patch must never overwrite. */
function geometryOf(box: Box) {
  return { x: box.x, y: box.y, w: box.w, h: box.h, shape: box.shape };
}

/** "Rear quarter" becomes "rear-quarter". The server has the final say. */
function keyFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/**
 * Apply a drag to the box it started from.
 *
 * Resizing pins the opposite edge and clamps the moving one, so a handle
 * dragged past its far side stops at the minimum instead of inverting the box.
 * Moving clamps the whole box inside the photo without changing its size, which
 * is why the offsets are clamped rather than the resulting corner.
 */
function applyDrag(start: Box, grip: Grip, dx: number, dy: number): Box {
  if (grip === "move") {
    return {
      ...start,
      x: round(clamp(start.x + dx, 0, 100 - start.w)),
      y: round(clamp(start.y + dy, 0, 100 - start.h)),
    };
  }

  let { x, y, w, h } = start;

  if (grip.includes("w")) {
    const right = start.x + start.w;
    x = clamp(start.x + dx, 0, right - MIN_SIDE);
    w = right - x;
  }
  if (grip.includes("e")) {
    w = clamp(start.w + dx, MIN_SIDE, 100 - start.x);
  }
  if (grip.includes("n")) {
    const bottom = start.y + start.h;
    y = clamp(start.y + dy, 0, bottom - MIN_SIDE);
    h = bottom - y;
  }
  if (grip.includes("s")) {
    h = clamp(start.h + dy, MIN_SIDE, 100 - start.y);
  }

  return { ...start, x: round(x), y: round(y), w: round(w), h: round(h) };
}

export default function SpotGeometryEditor({ call }: SpotGeometryEditorProps) {
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [saved, setSaved] = useState<Box[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const surface = useRef<HTMLDivElement>(null);

  /** Pointer pixels to photo percentages. One place, so the drag maths and the
   *  rendered boxes cannot drift apart. */
  const toPercent = useCallback((clientX: number, clientY: number) => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    };
  }, []);

  /**
   * Read the spots as the admin API sees them.
   *
   * Nothing is written to state before the fetch has been awaited, which keeps
   * the mount effect below a subscription to an external system rather than a
   * synchronous setState that cascades a second render out of the first.
   */
  const load = useCallback(async () => {
    let next: Box[] | null = null;
    try {
      const body = await call("/api/admin/spots");
      if (body && typeof body === "object" && Array.isArray((body as { spots?: Box[] }).spots)) {
        next = (body as { spots: Box[] }).spots;
      }
    } catch {
      next = null;
    }

    if (next === null) {
      setError("Couldn't read the spots. Is the auction seeded?");
      return;
    }
    setError(null);
    setBoxes(next);
    setSaved(next);
  }, [call]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  // The pointer leaves the box the moment a drag is fast enough, so the move
  // and up listeners live on the window rather than on the element. Capturing
  // the pointer would also work, but not for a drag that ends off the viewport.
  useEffect(() => {
    if (!drag) return;

    function onMove(event: PointerEvent) {
      if (!drag) return;
      const point = toPercent(event.clientX, event.clientY);
      if (!point) return;
      const dx = point.x - drag.originX;
      const dy = point.y - drag.originY;
      setBoxes((current) =>
        current
          ? current.map((box) =>
              box.key === drag.key ? applyDrag(drag.start, drag.grip, dx, dy) : box,
            )
          : current,
      );
    }

    function onUp() {
      setDrag(null);
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, toPercent]);

  const startDrag = useCallback(
    (event: ReactPointerEvent, box: Box, grip: Grip) => {
      // Left button only: a right-click drag would leave a drag running with no
      // pointerup to end it.
      if (event.button !== 0) return;
      const point = toPercent(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      setSelected(box.key);
      setNotice(null);
      setDrag({ key: box.key, grip, originX: point.x, originY: point.y, start: box });
    },
    [toPercent],
  );

  const nudge = useCallback((event: KeyboardEvent<HTMLDivElement>, box: Box) => {
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    // Alt turns the arrows into a resize, which is the only way to size a spot
    // precisely without a pointer.
    const sizing = event.altKey;

    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;

    event.preventDefault();
    setNotice(null);
    setBoxes((current) =>
      current
        ? current.map((candidate) =>
            candidate.key === box.key
              ? applyDrag(candidate, sizing ? "se" : "move", dx, dy)
              : candidate,
          )
        : current,
    );
  }, []);

  const dirty = useMemo(() => {
    if (!boxes || !saved) return false;
    return boxes.some((box) => {
      const before = saved.find((candidate) => candidate.key === box.key);
      return !before || !sameGeometry(box, before);
    });
  }, [boxes, saved]);

  const save = useCallback(async () => {
    if (!boxes) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const body = await call("/api/admin/spots", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          spots: boxes.map(({ key, x, y, w, h, shape }) => ({ key, x, y, w, h, shape })),
        }),
      });
      if (body === null) return; // `call` has already reported why.
      await load();
      setNotice("Positions saved. The board is already showing them.");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }, [boxes, call, load]);

  const reset = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const body = await call("/api/admin/spots", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      if (body === null) return;
      await load();
      setNotice("Back to the measurements that ship in src/config/car.ts.");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  }, [call, load]);

  /** Rename, re-panel or re-grade one spot. Goes to the server immediately. */
  const edit = useCallback(
    async (key: string, patch: Partial<Pick<Box, "name" | "panel" | "difficulty">>) => {
      setBusy(true);
      setNotice(null);
      setError(null);
      try {
        const body = await call(`/api/admin/spots/${encodeURIComponent(key)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (body === null) return;
        const updated = (body as { spot: Box }).spot;
        // Patched in place rather than reloaded: a reload here would throw away
        // any box that has been dragged but not saved yet. The server's own
        // geometry is dropped for the same reason.
        setBoxes((current) =>
          current
            ? current.map((box) =>
                box.key === key ? { ...box, ...updated, ...geometryOf(box) } : box,
              )
            : current,
        );
        setSaved((current) =>
          current
            ? current.map((box) =>
                box.key === key ? { ...box, ...updated, ...geometryOf(box) } : box,
              )
            : current,
        );
        setNotice(`${updated.name} updated.`);
      } catch {
        setError("Couldn't reach the server.");
      } finally {
        setBusy(false);
      }
    },
    [call],
  );

  const remove = useCallback(
    async (key: string) => {
      setBusy(true);
      setNotice(null);
      setError(null);
      try {
        const body = await call(`/api/admin/spots/${encodeURIComponent(key)}`, {
          method: "DELETE",
        });
        if (body === null) return;
        setConfirmDelete(null);
        setSelected(null);
        await load();
        setNotice(`${key} deleted. It is off the car and off the board.`);
      } catch {
        setError("Couldn't reach the server.");
      } finally {
        setBusy(false);
      }
    },
    [call, load],
  );

  const create = useCallback(
    async (draft: { name: string; panel: string; difficulty: Difficulty }) => {
      setBusy(true);
      setNotice(null);
      setError(null);
      try {
        const body = await call("/api/admin/spots", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // A new spot lands in the middle of the photo at a workable size, so
          // it is visible and grabbable straight away rather than having to be
          // hunted for before it can be positioned.
          body: JSON.stringify({
            key: keyFrom(draft.name),
            name: draft.name,
            panel: draft.panel,
            difficulty: draft.difficulty,
            x: 45,
            y: 45,
            w: 10,
            h: 10,
            shape: "rect",
          }),
        });
        if (body === null) return;
        const spot = (body as { spot: Box }).spot;
        setAdding(false);
        await load();
        setSelected(spot.key);
        setNotice(`${spot.name} added in the middle of the car. Drag it where it belongs.`);
      } catch {
        setError("Couldn't reach the server.");
      } finally {
        setBusy(false);
      }
    },
    [call, load],
  );

  const current = boxes?.find((box) => box.key === selected) ?? null;

  const setField = useCallback((key: string, field: "x" | "y" | "w" | "h", value: number) => {
    if (!Number.isFinite(value)) return;
    setNotice(null);
    setBoxes((all) =>
      all
        ? all.map((box) => {
            if (box.key !== key) return box;
            // Typing a number can put an edge off the photo just as a drag can,
            // so it goes through the same clamp.
            return applyDrag({ ...box, [field]: round(value) }, "move", 0, 0);
          })
        : all,
    );
  }, []);

  return (
    <section aria-labelledby="geometry-heading" className="mt-14">
      <div className="hairline-b flex flex-wrap items-end justify-between gap-4 pb-4">
        <div>
          <h2 id="geometry-heading" className="text-[17px] font-semibold tracking-[-0.015em] text-ink">
            Spots
          </h2>
          <p className="mt-1 max-w-[62ch] text-[13px] leading-[1.55] text-muted">
            Drag a box to move it, pull a handle to resize it. Arrow keys nudge the selected spot,
            hold shift for bigger steps and alt to resize. Every spot opens at the same price
            whatever its size, so moving one changes what gets cut in vinyl, not what it costs to
            bid on. A spot that has taken money cannot be deleted.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setAdding((was) => !was);
              setNotice(null);
            }}
            disabled={busy}
            className={`btn btn-secondary btn-sm ${FOCUS_RING}`}
          >
            {adding ? "Cancel" : "Add a spot"}
          </button>
          <button
            type="button"
            onClick={() => void reset()}
            disabled={busy}
            className={`btn btn-secondary btn-sm ${FOCUS_RING}`}
          >
            Restore survey
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty}
            className={`btn btn-primary btn-sm ${FOCUS_RING}`}
          >
            {busy ? "Working…" : dirty ? "Save positions" : "Saved"}
          </button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-[13px] text-live">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 text-[13px] text-good">
          {notice}
        </p>
      ) : null}

      {adding ? <AddSpot busy={busy} onCreate={create} /> : null}

      {boxes === null ? (
        <p className="mt-6 text-[13px] text-muted">Loading the board…</p>
      ) : (
        <div className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div
            ref={surface}
            className="relative w-full touch-none select-none rounded-xl bg-haze"
            style={{ aspectRatio: `${CAR.photoWidth} / ${CAR.photoHeight}` }}
            onPointerDown={() => setSelected(null)}
          >
            <Image
              src={CAR.photo}
              alt=""
              fill
              sizes="(max-width: 1024px) 100vw, 900px"
              draggable={false}
              className="pointer-events-none object-contain"
            />

            {boxes.map((box) => {
              const active = box.key === selected;
              return (
                <div
                  key={box.key}
                  role="button"
                  tabIndex={0}
                  aria-label={`${box.name}, ${Math.round(box.w)} by ${Math.round(box.h)} percent. Arrow keys move it, alt and arrow keys resize it.`}
                  onPointerDown={(event) => startDrag(event, box, "move")}
                  onFocus={() => setSelected(box.key)}
                  onKeyDown={(event) => nudge(event, box)}
                  className={`absolute cursor-move border-2 transition-colors duration-150 ${FOCUS_RING} ${
                    box.shape === "ellipse" ? "rounded-full" : "rounded-[3px]"
                  } ${
                    active
                      ? "border-signal bg-signal/20 z-10"
                      : "border-ink/45 bg-ink/5 hover:border-signal/70"
                  }`}
                  style={{
                    left: `${box.x}%`,
                    top: `${box.y}%`,
                    width: `${box.w}%`,
                    height: `${box.h}%`,
                  }}
                >
                  <span
                    className={`pointer-events-none absolute -top-5 left-0 whitespace-nowrap text-[10px] font-medium ${
                      active ? "text-signal" : "text-faint"
                    }`}
                  >
                    {box.name}
                  </span>

                  {active
                    ? HANDLES.map((handle) => (
                        <span
                          key={handle.grip}
                          role="presentation"
                          onPointerDown={(event) => startDrag(event, box, handle.grip)}
                          title={`Resize from the ${handle.label}`}
                          className={`absolute block h-2.5 w-2.5 rounded-full border border-canvas bg-signal ${handle.className}`}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </div>

          <div>
            {current ? (
              <Panel
                box={current}
                busy={busy}
                confirming={confirmDelete === current.key}
                onField={setField}
                onEdit={edit}
                onAskDelete={() => setConfirmDelete(current.key)}
                onCancelDelete={() => setConfirmDelete(null)}
                onDelete={() => void remove(current.key)}
              />
            ) : (
              <p className="text-[13px] leading-[1.55] text-muted">
                Select a spot on the car to rename it, resize it or remove it.
              </p>
            )}

            <ul className="hairline-t mt-6 space-y-1 pt-4">
              {boxes.map((box) => (
                <li key={box.key}>
                  <button
                    type="button"
                    onClick={() => setSelected(box.key)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 ${FOCUS_RING} ${
                      box.key === selected ? "bg-signal/10 text-signal" : "text-muted hover:text-ink"
                    }`}
                  >
                    <span className="truncate">{box.name}</span>
                    {box.bidCount > 0 ? (
                      <span className="tabular shrink-0 text-[11px] text-faint">
                        {box.bidCount} bid{box.bidCount === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * New spot
 * ------------------------------------------------------------------ */

/**
 * A new spot needs a name and a panel; everything else has a sane default and
 * is easier to set by dragging than by typing. It lands in the middle of the
 * car and is positioned from there.
 */
function AddSpot({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (draft: { name: string; panel: string; difficulty: Difficulty }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [panel, setPanel] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("mild");

  const ready = name.trim().length > 0 && panel.trim().length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        void onCreate({ name: name.trim(), panel: panel.trim(), difficulty });
      }}
      className="mt-5 rounded-xl border border-hairline p-4"
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_auto] sm:items-end">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.06em] text-faint">Name</span>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Wing mirror"
            maxLength={60}
            className={`mt-1 w-full rounded-lg border border-hairline bg-canvas px-2.5 py-2 text-[13px] outline-none focus:border-signal ${FOCUS_RING}`}
          />
        </label>
        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.06em] text-faint">Panel</span>
          <input
            type="text"
            value={panel}
            onChange={(event) => setPanel(event.target.value)}
            placeholder="Driver's wing mirror"
            maxLength={60}
            className={`mt-1 w-full rounded-lg border border-hairline bg-canvas px-2.5 py-2 text-[13px] outline-none focus:border-signal ${FOCUS_RING}`}
          />
        </label>
        <label className="block">
          <span className="block text-[11px] uppercase tracking-[0.06em] text-faint">Surface</span>
          <select
            value={difficulty}
            onChange={(event) => setDifficulty(event.target.value as Difficulty)}
            className={`mt-1 w-full rounded-lg border border-hairline bg-canvas px-2.5 py-2 text-[13px] outline-none focus:border-signal ${FOCUS_RING}`}
          >
            {DIFFICULTIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !ready}
          className={`btn btn-primary btn-sm ${FOCUS_RING}`}
        >
          Add
        </button>
      </div>
      <p className="mt-3 text-[12px] text-faint">
        It opens on the same clock, and at the same price, as every other spot.
      </p>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * The selected spot
 * ------------------------------------------------------------------ */

/**
 * Everything about one spot that is easier typed than dragged.
 *
 * Percentages are what the board stores, but nobody thinks in them, so the real
 * centimetres sit beside them. Two money figures are shown and they mean
 * different things: what the spot opens at, which is the same for every spot,
 * and what its vinyl would actually cost to cut and fit, which is worth knowing
 * when a bid comes in under it.
 */
function Panel({
  box,
  busy,
  confirming,
  onField,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: {
  box: Box;
  busy: boolean;
  confirming: boolean;
  onField: (key: string, field: "x" | "y" | "w" | "h", value: number) => void;
  onEdit: (
    key: string,
    patch: Partial<Pick<Box, "name" | "panel" | "difficulty">>,
  ) => Promise<void>;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  // Null means "untouched", so a name arriving from the server cannot overwrite
  // one being typed.
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [panelEdit, setPanelEdit] = useState<string | null>(null);

  // Re-arm when the selection changes, during render rather than in an effect,
  // so the fields never paint one frame of the previous spot's text.
  const [armedFor, setArmedFor] = useState<string | null>(null);
  if (box.key !== armedFor) {
    setArmedFor(box.key);
    setNameEdit(null);
    setPanelEdit(null);
  }

  const name = nameEdit ?? box.name;
  const panel = panelEdit ?? box.panel;

  const FIELDS: ReadonlyArray<{ field: "x" | "y" | "w" | "h"; label: string }> = [
    { field: "x", label: "Left %" },
    { field: "y", label: "Top %" },
    { field: "w", label: "Width %" },
    { field: "h", label: "Height %" },
  ];

  const frozen = box.bidCount > 0;

  return (
    <div className="rounded-xl border border-hairline p-4">
      <label className="block">
        <span className="block text-[11px] uppercase tracking-[0.06em] text-faint">Name</span>
        <input
          type="text"
          value={name}
          maxLength={60}
          disabled={busy}
          onChange={(event) => setNameEdit(event.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (next && next !== box.name) void onEdit(box.key, { name: next });
          }}
          className={`mt-1 w-full rounded-lg border border-hairline bg-canvas px-2.5 py-2 text-[14px] font-medium outline-none focus:border-signal ${FOCUS_RING}`}
        />
      </label>

      <label className="mt-3 block">
        <span className="block text-[11px] uppercase tracking-[0.06em] text-faint">Panel</span>
        <input
          type="text"
          value={panel}
          maxLength={60}
          disabled={busy}
          onChange={(event) => setPanelEdit(event.target.value)}
          onBlur={() => {
            const next = panel.trim();
            if (next && next !== box.panel) void onEdit(box.key, { panel: next });
          }}
          className={`mt-1 w-full rounded-lg border border-hairline bg-canvas px-2.5 py-2 text-[13px] outline-none focus:border-signal ${FOCUS_RING}`}
        />
      </label>

      <label className="mt-3 block">
        <span className="block text-[11px] uppercase tracking-[0.06em] text-faint">Surface</span>
        <select
          value={box.difficulty}
          disabled={busy}
          onChange={(event) =>
            void onEdit(box.key, { difficulty: event.target.value as Difficulty })
          }
          className={`mt-1 w-full rounded-lg border border-hairline bg-canvas px-2.5 py-2 text-[13px] outline-none focus:border-signal ${FOCUS_RING}`}
        >
          {DIFFICULTIES.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <p className="mt-3 text-[11px] text-faint">
        Key <code className="font-mono">{box.key}</code>, which never changes.
      </p>

      <div className="hairline-t mt-4 grid grid-cols-2 gap-3 pt-4">
        {FIELDS.map(({ field, label }) => (
          <label key={field} className="block">
            <span className="block text-[11px] uppercase tracking-[0.06em] text-faint">{label}</span>
            <input
              type="number"
              step="0.1"
              min={0}
              max={100}
              value={box[field]}
              onChange={(event) => onField(box.key, field, Number(event.target.value))}
              className={`tabular mt-1 w-full rounded-lg border border-hairline bg-canvas px-2 py-1.5 text-[13px] outline-none focus:border-signal ${FOCUS_RING}`}
            />
          </label>
        ))}
      </div>

      <dl className="hairline-t mt-4 space-y-1.5 pt-3 text-[12px]">
        <div className="flex justify-between gap-3">
          <dt className="text-faint">Real size</dt>
          <dd className="tabular text-ink">
            {Math.round(box.widthCm)} × {Math.round(box.heightCm)} cm
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-faint">Opens at</dt>
          <dd className="tabular text-ink">{formatMoney(box.floorPriceCents)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-faint">Vinyl and fitting</dt>
          <dd className="tabular text-muted">{formatMoney(box.productionCostCents)}</dd>
        </div>
      </dl>

      <div className="hairline-t mt-4 pt-4">
        {frozen ? (
          <p className="text-[12px] leading-[1.5] text-faint">
            {box.bidCount} bid{box.bidCount === 1 ? "" : "s"} against this spot, so it cannot be
            deleted.
          </p>
        ) : confirming ? (
          <div>
            <p className="text-[12px] leading-[1.5] text-ink">
              Delete {box.name}? It disappears from the car and the board. There is no undo.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onDelete}
                disabled={busy}
                className={`btn btn-sm bg-live text-white hover:opacity-90 ${FOCUS_RING}`}
              >
                Delete it
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                disabled={busy}
                className={`btn btn-secondary btn-sm ${FOCUS_RING}`}
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onAskDelete}
            disabled={busy}
            className={`text-[12px] text-live hover:underline ${FOCUS_RING}`}
          >
            Delete this spot
          </button>
        )}
      </div>
    </div>
  );
}
