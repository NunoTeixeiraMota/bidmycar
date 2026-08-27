"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { formatMoney } from "@/lib/money";
import type { Bid, CloseResult, ReviewStatus, SpotStatus } from "@/lib/types";

/**
 * Admin console.
 *
 * The token lives in component state and nowhere else. It is a bearer
 * credential: in localStorage it would survive the tab, be readable by any
 * script that ever gets injected into this origin, and sit on a shared laptop
 * indefinitely. Reloading the page and typing it again is the correct cost.
 */

interface AdminSpot {
  id?: string;
  key: string;
  name: string;
  panel?: string;
  status: SpotStatus;
  closesAt: number;
  floorPriceCents: number;
  currentPriceCents?: number;
  bidCount?: number;
  holder?: { displayName: string; email?: string; since?: number } | null;
}

interface AdminBid extends Bid {
  spotKey?: string;
  spotName?: string;
  bidderEmail?: string;
  bidderName?: string;
}

interface AdminArtwork {
  id: string;
  bidId: string;
  spotId?: string;
  spotKey?: string;
  spotName?: string;
  bidderId?: string;
  bidderName?: string;
  bidderEmail?: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  reviewStatus: ReviewStatus;
  rejectionReason: string | null;
  createdAt: number;
}

interface AdminSummary {
  spots?: AdminSpot[];
  bids?: AdminBid[];
  artwork?: AdminArtwork[];
  totalRaisedCents?: number;
  spotsTaken?: number;
  spotsTotal?: number;
  demo?: boolean;
}

/** Everything unusual the console can be told, in the words it should use. */
type Failure =
  | { kind: "unauthorised" }
  | { kind: "unconfigured" }
  | { kind: "other"; message: string };

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
const CELL = "px-3 py-2 align-top";
const HEAD = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-faint";

function failureFor(status: number, body: unknown): Failure {
  if (status === 401 || status === 403) return { kind: "unauthorised" };
  if (status === 503) return { kind: "unconfigured" };
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    for (const key of ["error", "message", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return { kind: "other", message: value.trim() };
      }
    }
  }
  return { kind: "other", message: `Request failed (${status}).` };
}

function stamp(epochMs: number | null | undefined): string {
  if (!epochMs) return "—";
  return new Intl.DateTimeFormat("en-IE", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(epochMs));
}

export default function AdminPage() {
  const [token, setToken] = useState("");
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const authorised = summary !== null;

  const call = useCallback(
    async (path: string, init?: RequestInit): Promise<unknown | null> => {
      const response = await fetch(path, {
        ...init,
        cache: "no-store",
        headers: { ...(init?.headers ?? {}), "x-admin-token": token },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setFailure(failureFor(response.status, body));
        // A rejected token must drop the console back to the gate rather than
        // leaving a stale summary on screen that looks authorised.
        if (response.status === 401 || response.status === 403) setSummary(null);
        return null;
      }
      setFailure(null);
      return body;
    },
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const body = await call("/api/admin/summary");
      if (body !== null) setSummary(body as AdminSummary);
    } catch {
      setFailure({ kind: "other", message: "Couldn't reach the server." });
    } finally {
      setBusy(false);
    }
  }, [call, token]);

  if (!authorised) {
    return <TokenGate token={token} onToken={setToken} onSubmit={load} busy={busy} failure={failure} />;
  }

  return (
    <main className="py-12 sm:py-16">
      <div className="shell-wide">
        <Header
          summary={summary}
          busy={busy}
          onRefresh={load}
          onSignOut={() => {
            setToken("");
            setSummary(null);
            setFailure(null);
            setNotice(null);
          }}
        />

        {failure ? <FailureNote failure={failure} /> : null}
        {notice ? (
          <p role="status" className="mt-6 rounded-lg bg-good/10 px-4 py-3 text-[13px] text-good">
            {notice}
          </p>
        ) : null}

        <ArtworkQueue
          artwork={summary.artwork ?? []}
          token={token}
          call={call}
          onDone={async (message) => {
            setNotice(message);
            await load();
          }}
        />

        <SpotsTable spots={summary.spots ?? []} />

        <BidsTable bids={summary.bids ?? []} spots={summary.spots ?? []} />

        <CloseAuction call={call} onClosed={load} />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Gate
 * ------------------------------------------------------------------ */

function TokenGate({
  token,
  onToken,
  onSubmit,
  busy,
  failure,
}: {
  token: string;
  onToken: (value: string) => void;
  onSubmit: () => Promise<void>;
  busy: boolean;
  failure: Failure | null;
}) {
  const fieldId = useId();
  return (
    <main className="section">
      <div className="shell">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
          className="mx-auto max-w-[420px]"
        >
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Admin console</h1>
          <p className="mt-2 text-[14px] leading-[1.6] text-muted">
            Paste the value of <code className="font-mono text-[13px]">ADMIN_TOKEN</code>. It is
            held in memory for this tab only and is gone when you reload.
          </p>

          <label htmlFor={fieldId} className="mt-8 block text-[13px] font-medium text-ink">
            Admin token
          </label>
          <input
            id={fieldId}
            type="password"
            value={token}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onToken(event.target.value)}
            className={`mt-2 w-full rounded-lg border border-hairline bg-canvas px-3 py-2.5 font-mono text-[13px] text-ink ${FOCUS_RING}`}
          />

          <button
            type="submit"
            disabled={busy || token.trim().length === 0}
            className={`btn btn-dark btn-md mt-5 w-full ${FOCUS_RING}`}
          >
            {busy ? "Checking…" : "Open console"}
          </button>

          {failure ? <FailureNote failure={failure} /> : null}
        </form>
      </div>
    </main>
  );
}

function FailureNote({ failure }: { failure: Failure }) {
  if (failure.kind === "unconfigured") {
    return (
      <div role="alert" className="mt-6 rounded-lg border border-live/30 bg-live/5 p-4">
        <p className="text-[13px] font-semibold text-live">Admin API disabled (503)</p>
        <p className="mt-1.5 text-[13px] leading-[1.6] text-ink">
          <code className="font-mono">ADMIN_TOKEN</code> is not set on the server, so the admin
          endpoints refuse every request rather than defaulting open. Set it in{" "}
          <code className="font-mono">.env.local</code> and restart:
        </p>
        <pre className="mt-3 overflow-x-auto rounded bg-graphite px-3 py-2 font-mono text-[12px] text-white">
ADMIN_TOKEN=$(openssl rand -hex 32)
        </pre>
      </div>
    );
  }

  if (failure.kind === "unauthorised") {
    return (
      <div role="alert" className="mt-6 rounded-lg border border-live/30 bg-live/5 p-4">
        <p className="text-[13px] font-semibold text-live">Token rejected (401)</p>
        <p className="mt-1.5 text-[13px] leading-[1.6] text-ink">
          That is not the value of <code className="font-mono">ADMIN_TOKEN</code> on this server.
          Check for a trailing newline if you pasted it out of a file.
        </p>
      </div>
    );
  }

  return (
    <div role="alert" className="mt-6 rounded-lg border border-live/30 bg-live/5 p-4">
      <p className="text-[13px] font-semibold text-live">Request failed</p>
      <p className="mt-1.5 text-[13px] leading-[1.6] text-ink">{failure.message}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Console furniture
 * ------------------------------------------------------------------ */

function Header({
  summary,
  busy,
  onRefresh,
  onSignOut,
}: {
  summary: AdminSummary;
  busy: boolean;
  onRefresh: () => Promise<void>;
  onSignOut: () => void;
}) {
  const pending = (summary.artwork ?? []).filter((a) => a.reviewStatus === "pending").length;
  return (
    <div className="hairline-b flex flex-wrap items-end justify-between gap-4 pb-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-ink">Admin console</h1>
        <p className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">
          <span className="tabular">
            {formatMoney(summary.totalRaisedCents ?? 0)} raised
          </span>
          <span className="tabular">
            {summary.spotsTaken ?? 0}/{summary.spotsTotal ?? (summary.spots?.length ?? 0)} spots held
          </span>
          <span className="tabular">{pending} artwork awaiting review</span>
          {summary.demo ? <span className="text-live">demo mode — no real charges</span> : null}
        </p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={busy}
          className={`btn btn-secondary btn-sm ${FOCUS_RING}`}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" onClick={onSignOut} className={`btn btn-secondary btn-sm ${FOCUS_RING}`}>
          Forget token
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Artwork review
 * ------------------------------------------------------------------ */

function ArtworkThumb({ artworkId, token, alt }: { artworkId: string; token: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  // An <img> cannot send the admin header, and unapproved artwork is 404 to
  // anyone who does not, so the bytes are fetched and handed over as a blob.
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/artwork/${artworkId}/file`, {
          cache: "no-store",
          headers: { "x-admin-token": token },
        });
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artworkId, token]);

  return (
    <div
      className="flex h-32 w-32 shrink-0 items-center justify-center rounded border border-hairline"
      style={{
        backgroundImage:
          "linear-gradient(45deg,#e8e8ed 25%,transparent 25%,transparent 75%,#e8e8ed 75%),linear-gradient(45deg,#e8e8ed 25%,transparent 25%,transparent 75%,#e8e8ed 75%)",
        backgroundSize: "16px 16px",
        backgroundPosition: "0 0, 8px 8px",
      }}
    >
      {failed ? (
        <span className="px-2 text-center text-[11px] text-faint">preview unavailable</span>
      ) : url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={alt} className="h-full w-full object-contain p-2" />
      ) : (
        <span className="text-[11px] text-faint">loading</span>
      )}
    </div>
  );
}

function ArtworkQueue({
  artwork,
  token,
  call,
  onDone,
}: {
  artwork: AdminArtwork[];
  token: string;
  call: (path: string, init?: RequestInit) => Promise<unknown | null>;
  onDone: (message: string) => Promise<void>;
}) {
  const pending = useMemo(
    () => artwork.filter((item) => item.reviewStatus === "pending"),
    [artwork],
  );
  const decided = useMemo(
    () => artwork.filter((item) => item.reviewStatus !== "pending"),
    [artwork],
  );

  return (
    <section aria-labelledby="admin-artwork">
      <h2 id="admin-artwork" className="mt-12 text-[15px] font-semibold tracking-[-0.01em] text-ink">
        Artwork review <span className="tabular ml-1 font-normal text-faint">{pending.length}</span>
      </h2>

      {pending.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">Nothing waiting.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {pending.map((item) => (
            <ArtworkRow key={item.id} item={item} token={token} call={call} onDone={onDone} />
          ))}
        </ul>
      )}

      {decided.length > 0 ? (
        <details className="mt-5">
          <summary className={`cursor-pointer text-[13px] text-muted ${FOCUS_RING}`}>
            {decided.length} already decided
          </summary>
          <ul className="mt-3 space-y-1.5">
            {decided.map((item) => (
              <li key={item.id} className="tabular text-[12px] text-muted">
                <span
                  className={item.reviewStatus === "approved" ? "text-good" : "text-live"}
                >
                  {item.reviewStatus}
                </span>{" "}
                · {item.spotKey ?? item.spotId ?? "?"} · {item.filename}
                {item.rejectionReason ? ` · ${item.rejectionReason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function ArtworkRow({
  item,
  token,
  call,
  onDone,
}: {
  item: AdminArtwork;
  token: string;
  call: (path: string, init?: RequestInit) => Promise<unknown | null>;
  onDone: (message: string) => Promise<void>;
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function decide(decision: "approve" | "reject") {
    if (busy) return;
    if (decision === "reject" && reason.trim().length === 0) return;
    setBusy(true);
    try {
      const body = await call(`/api/admin/artwork/${encodeURIComponent(item.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          decision === "reject" ? { decision, reason: reason.trim() } : { decision },
        ),
      });
      if (body !== null) {
        await onDone(`${item.filename} ${decision === "approve" ? "approved" : "rejected"}.`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex flex-col gap-4 rounded-lg border border-hairline p-4 sm:flex-row">
      <ArtworkThumb artworkId={item.id} token={token} alt={`Uploaded artwork ${item.filename}`} />

      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">
          {item.spotName ?? item.spotKey ?? item.spotId ?? "Unknown spot"}
        </p>
        <p className="tabular mt-1 text-[12px] text-muted">
          {item.filename} · {item.mimeType} · {(item.byteSize / 1024).toFixed(0)} KB ·{" "}
          {stamp(item.createdAt)}
        </p>
        <p className="tabular mt-0.5 text-[12px] text-faint">
          bid {item.bidId}
          {item.bidderName ? ` · ${item.bidderName}` : ""}
          {item.bidderEmail ? ` · ${item.bidderEmail}` : ""}
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label htmlFor={reasonId} className="block text-[11px] text-faint">
              Reason (required to reject — the bidder reads this)
            </label>
            <input
              id={reasonId}
              type="text"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className={`mt-1 w-full rounded border border-hairline bg-canvas px-2.5 py-1.5 text-[13px] text-ink ${FOCUS_RING}`}
            />
          </div>
          <button
            type="button"
            onClick={() => void decide("approve")}
            disabled={busy}
            className={`btn btn-dark btn-sm ${FOCUS_RING}`}
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => void decide("reject")}
            disabled={busy || reason.trim().length === 0}
            className={`btn btn-sm border border-live bg-transparent text-live hover:bg-live hover:text-white ${FOCUS_RING}`}
          >
            Reject
          </button>
        </div>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Tables
 * ------------------------------------------------------------------ */

function SpotsTable({ spots }: { spots: AdminSpot[] }) {
  return (
    <section aria-labelledby="admin-spots">
      <h2 id="admin-spots" className="mt-14 text-[15px] font-semibold tracking-[-0.01em] text-ink">
        Spots <span className="tabular ml-1 font-normal text-faint">{spots.length}</span>
      </h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead className="hairline-b">
            <tr>
              <th scope="col" className={HEAD}>Spot</th>
              <th scope="col" className={HEAD}>Status</th>
              <th scope="col" className={HEAD}>Floor</th>
              <th scope="col" className={HEAD}>Price</th>
              <th scope="col" className={HEAD}>Bids</th>
              <th scope="col" className={HEAD}>Holder</th>
              <th scope="col" className={HEAD}>Closes</th>
            </tr>
          </thead>
          <tbody>
            {spots.length === 0 ? (
              <tr>
                <td className={`${CELL} text-muted`} colSpan={7}>
                  No spots. Run <code className="font-mono">npm run seed</code>.
                </td>
              </tr>
            ) : (
              spots.map((spot) => (
                <tr key={spot.key} className="hairline-b">
                  <th scope="row" className={`${CELL} text-left font-medium text-ink`}>
                    {spot.name}
                    <span className="ml-1.5 font-mono text-[11px] font-normal text-faint">
                      {spot.key}
                    </span>
                  </th>
                  <td className={`${CELL} text-muted`}>{spot.status}</td>
                  <td className={`${CELL} tabular text-muted`}>
                    {formatMoney(spot.floorPriceCents)}
                  </td>
                  <td className={`${CELL} tabular font-medium text-ink`}>
                    {formatMoney(spot.currentPriceCents ?? spot.floorPriceCents)}
                  </td>
                  <td className={`${CELL} tabular text-muted`}>{spot.bidCount ?? 0}</td>
                  <td className={`${CELL} text-muted`}>
                    {spot.holder ? (
                      <>
                        {spot.holder.displayName}
                        {spot.holder.email ? (
                          <span className="block text-[11px] text-faint">{spot.holder.email}</span>
                        ) : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className={`${CELL} tabular text-muted`}>{stamp(spot.closesAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BidsTable({ bids, spots }: { bids: AdminBid[]; spots: AdminSpot[] }) {
  // The ledger carries spotId; the operator needs the spot's name.
  const spotById = useMemo(() => {
    const map = new Map<string, AdminSpot>();
    for (const spot of spots) if (spot.id) map.set(spot.id, spot);
    return map;
  }, [spots]);

  const ordered = useMemo(() => [...bids].sort((a, b) => b.createdAt - a.createdAt), [bids]);

  return (
    <section aria-labelledby="admin-bids">
      <h2 id="admin-bids" className="mt-14 text-[15px] font-semibold tracking-[-0.01em] text-ink">
        Bids <span className="tabular ml-1 font-normal text-faint">{bids.length}</span>
      </h2>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse text-[13px]">
          <thead className="hairline-b">
            <tr>
              <th scope="col" className={HEAD}>Placed</th>
              <th scope="col" className={HEAD}>Spot</th>
              <th scope="col" className={HEAD}>Bidder</th>
              <th scope="col" className={HEAD}>Amount</th>
              <th scope="col" className={HEAD}>Status</th>
              <th scope="col" className={HEAD}>Refunded</th>
              <th scope="col" className={HEAD}>Stripe</th>
            </tr>
          </thead>
          <tbody>
            {ordered.length === 0 ? (
              <tr>
                <td className={`${CELL} text-muted`} colSpan={7}>
                  No bids yet.
                </td>
              </tr>
            ) : (
              ordered.map((bid) => {
                const spot = bid.spotKey ?? spotById.get(bid.spotId)?.key ?? bid.spotId;
                const tone =
                  bid.status === "paid" || bid.status === "won"
                    ? "text-good"
                    : bid.status === "failed"
                      ? "text-live"
                      : "text-muted";
                return (
                  <tr key={bid.id} className="hairline-b">
                    <td className={`${CELL} tabular text-muted`}>{stamp(bid.createdAt)}</td>
                    <td className={`${CELL} font-mono text-[12px] text-ink`}>{spot}</td>
                    <td className={`${CELL} text-muted`}>
                      {bid.bidderName ?? bid.bidderId}
                      {bid.bidderEmail ? (
                        <span className="block text-[11px] text-faint">{bid.bidderEmail}</span>
                      ) : null}
                    </td>
                    <td className={`${CELL} tabular font-medium text-ink`}>
                      {formatMoney(bid.amountCents)}
                    </td>
                    <td className={`${CELL} ${tone}`}>{bid.status}</td>
                    <td className={`${CELL} tabular text-muted`}>{stamp(bid.refundedAt)}</td>
                    <td className={`${CELL} font-mono text-[11px] text-faint`}>
                      {bid.stripePaymentIntentId ?? bid.stripeCheckoutSessionId ?? "—"}
                      {bid.stripeRefundId ? (
                        <span className="block">{bid.stripeRefundId}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Close
 * ------------------------------------------------------------------ */

const CONFIRM_PHRASE = "CLOSE AUCTION";

interface CloseOutcome extends CloseResult {
  /** Present when the engine reports per-refund detail; not required. */
  refunds?: Array<{ bidId: string; ok: boolean; error?: string; amountCents?: number }>;
}

function CloseAuction({
  call,
  onClosed,
}: {
  call: (path: string, init?: RequestInit) => Promise<unknown | null>;
  onClosed: () => Promise<void>;
}) {
  const fieldId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseOutcome | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const armed = typed.trim().toUpperCase() === CONFIRM_PHRASE;

  async function close() {
    if (!armed || busy) return;
    setBusy(true);
    try {
      const body = await call("/api/admin/close", { method: "POST" });
      if (body !== null) {
        setResult(body as CloseOutcome);
        setTyped("");
        await onClosed();
        resultRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="admin-close" className="mt-16 rounded-lg border border-live/30 p-5">
      <h2 id="admin-close" className="text-[15px] font-semibold tracking-[-0.01em] text-live">
        Close the auction now
      </h2>
      <p className="mt-2 max-w-[560px] text-[13px] leading-[1.6] text-muted">
        Stops every spot immediately, marks the standing top bid on each as won, and refunds every
        bid that was outbid but never refunded. There is no undo, and bidders will be charged
        nothing further.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={fieldId} className="block text-[11px] text-faint">
            Type <span className="font-mono text-ink">{CONFIRM_PHRASE}</span> to enable
          </label>
          <input
            id={fieldId}
            type="text"
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
            className={`mt-1 w-[220px] rounded border border-hairline bg-canvas px-2.5 py-1.5 font-mono text-[13px] text-ink ${FOCUS_RING}`}
          />
        </div>
        <button
          type="button"
          onClick={() => void close()}
          disabled={!armed || busy}
          className={`btn btn-sm bg-live text-white ${FOCUS_RING}`}
        >
          {busy ? "Closing…" : "Close auction"}
        </button>
      </div>

      {result ? <CloseReport result={result} ref={resultRef} /> : null}
    </section>
  );
}

/**
 * What closing actually did. The engine may or may not report per-refund
 * detail; either way the operator sees one row per refunded bid rather than a
 * bare count, because a refund that failed is the only thing on this page that
 * needs a human tonight.
 */
function CloseReport({ result, ref }: { result: CloseOutcome; ref: Ref<HTMLDivElement> }) {
  const winners = result.winners ?? [];
  const refunds =
    result.refunds ??
    (result.refundedBidIds ?? []).map((bidId) => ({
      bidId,
      ok: true,
      error: undefined as string | undefined,
    }));

  return (
    <div ref={ref} tabIndex={-1} className="mt-6 outline-none" aria-live="polite">
      <p className="tabular text-[13px] text-ink">
        {result.closedSpots} spots closed · {winners.length} winners · {refunds.length} refunds
      </p>

      {winners.length > 0 ? (
        <ul className="mt-3 space-y-1 text-[12px]">
          {winners.map((winner) => (
            <li key={winner.bidId} className="tabular text-good">
              won · {winner.spotKey} · {formatMoney(winner.amountCents)} · bid {winner.bidId}
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-3 space-y-1 text-[12px]">
        {refunds.map((refund) => (
          <li key={refund.bidId} className={`tabular ${refund.ok ? "text-muted" : "text-live"}`}>
            refund {refund.ok ? "issued" : "FAILED"} · bid {refund.bidId}
            {refund.error ? ` · ${refund.error}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
