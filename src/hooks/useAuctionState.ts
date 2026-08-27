"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AuctionState } from "@/lib/types";

/**
 * Live board state, streamed.
 *
 * The stream is the fast path and polling is the safety net: proxies, mobile
 * radios and sleeping tabs all kill long-lived connections, and a board that
 * silently freezes on a stale price is worse than one that refreshes slowly.
 */

export interface UseAuctionStateResult {
  state: AuctionState;
  /** True only while an open stream is delivering; false while polling. */
  connected: boolean;
  /** Human-readable, safe to show. Null when everything is healthy. */
  error: string | null;
  /** Force one immediate read of /api/auction/state, after placing a bid. */
  refresh: () => Promise<void>;
}

const POLL_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

export function useAuctionState(initial: AuctionState): UseAuctionStateResult {
  // Seeded from the server-rendered payload: the first paint already shows real
  // prices, so nothing flashes empty while the stream opens.
  const [state, setState] = useState<AuctionState>(initial);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fetch begun before unmount still resolves after it; without this guard it
  // would set state on a dead component.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/auction/state", { cache: "no-store" });
      if (!response.ok) throw new Error(`state responded ${response.status}`);
      const next = (await response.json()) as AuctionState;
      if (!aliveRef.current) return;
      setState(next);
      setError(null);
    } catch {
      if (!aliveRef.current) return;
      setError("Couldn't reach the auction. Retrying.");
    }
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnectTimer = 0;
    let pollTimer = 0;
    let attempt = 0;
    let torndown = false;

    const stopPolling = () => {
      if (!pollTimer) return;
      window.clearInterval(pollTimer);
      pollTimer = 0;
    };

    const startPolling = () => {
      if (pollTimer || torndown) return;
      void refresh();
      pollTimer = window.setInterval(() => void refresh(), POLL_MS);
    };

    const connect = () => {
      if (torndown) return;
      const stream = new EventSource("/api/auction/stream");
      source = stream;

      stream.onopen = () => {
        if (torndown) return;
        setConnected(true);
        setError(null);
        stopPolling();
      };

      stream.addEventListener("state", (event) => {
        if (torndown) return;
        let next: AuctionState;
        try {
          next = JSON.parse((event as MessageEvent<string>).data) as AuctionState;
        } catch {
          return; // one malformed frame is not a reason to tear the stream down
        }
        // Backoff resets on delivered data, not on a successful handshake: a
        // server that accepts the connection and immediately dies would
        // otherwise put us in a reconnect hot loop.
        attempt = 0;
        setState(next);
      });

      stream.onerror = () => {
        // EventSource reconnects on its own, but with an interval we cannot cap
        // and no way to fall back, so take the connection over entirely.
        stream.close();
        if (source === stream) source = null;
        if (torndown) return;

        setConnected(false);
        setError("Live updates interrupted. Prices are refreshing every few seconds.");
        startPolling();

        const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
        attempt += 1;
        // Jitter so a server restart doesn't bring every open tab back at once.
        reconnectTimer = window.setTimeout(connect, delay + Math.random() * 400);
      };
    };

    if (typeof EventSource === "undefined") {
      startPolling();
    } else {
      connect();
    }

    return () => {
      torndown = true;
      // An abandoned EventSource holds its socket and keeps retrying; a few
      // navigations of that exhausts the browser's per-origin connection pool.
      source?.close();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      stopPolling();
    };
  }, [refresh]);

  return { state, connected, error, refresh };
}

export default useAuctionState;
