import type { NextRequest } from "next/server";

import { getAuctionState } from "@/lib/auction";

/**
 * The board again, but pushed.
 *
 * Server-Sent Events rather than a socket: the traffic is one-way, the payload
 * is the same JSON the polling route returns, and EventSource is the only
 * live-update transport that survives a proxy without a handshake.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

const encoder = new TextEncoder();

/** A comment frame: no `event:`, so a client ignores it entirely. */
const HEARTBEAT = encoder.encode(": ping\n\n");

function stateFrame(): Uint8Array {
  return encoder.encode(`event: state\ndata: ${JSON.stringify(getAuctionState(Date.now()))}\n\n`);
}

export function GET(request: NextRequest): Response {
  // Built before the stream opens so a database that will not read answers with
  // a 500 the client can retry against, rather than with a connection that
  // establishes and then dies on its first frame.
  const opening = stateFrame();

  let stateTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  /**
   * Every exit path leads here.
   *
   * An interval left running after a client disconnects keeps a closure, and
   * through it a database read every two seconds, alive for a reader that no
   * longer exists. A handful of reloads is enough to bury the dev server, so
   * this is called from cancel(), from abort, and from any failed write.
   */
  const stop = (): void => {
    if (closed) return;
    closed = true;
    if (stateTimer) clearInterval(stateTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    stateTimer = null;
    heartbeatTimer = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // enqueue() throws once the reader is gone rather than reporting it, and
      // a throw inside a timer is an unhandled rejection that takes the process
      // with it. Treat the throw as the disconnect notice it actually is.
      const push = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          stop();
        }
      };

      push(opening);

      stateTimer = setInterval(() => {
        if (closed) return;
        let frame: Uint8Array;
        try {
          frame = stateFrame();
        } catch (error) {
          // The board is unreadable. Failing the stream is what puts the client
          // into its polling fallback with a visible message; silently skipping
          // the frame would leave it showing stale prices as if they were live.
          stop();
          try {
            controller.error(error);
          } catch {
            // Already torn down at the other end; nothing left to report to.
          }
          return;
        }
        push(frame);
      }, STATE_INTERVAL_MS);

      // Redundant while state frames are flowing, and exactly the point: it is
      // the one frame that still goes out if a state read is slow, which is
      // what stops an intermediary timing the connection out mid-hiccup.
      heartbeatTimer = setInterval(() => push(HEARTBEAT), HEARTBEAT_INTERVAL_MS);

      // cancel() covers a reader that lets go politely. A request aborted under
      // us (a closed tab, a dropped mobile radio) may not reach it.
      request.signal.addEventListener("abort", stop, { once: true });
    },

    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform as well as no-cache: a proxy that gzips this would buffer
      // it, and a buffered event stream arrives all at once or not at all.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx's own buffering ignores Cache-Control and needs telling directly.
      "x-accel-buffering": "no",
    },
  });
}
