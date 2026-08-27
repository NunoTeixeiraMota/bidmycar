"use client";

import { useEffect } from "react";

/**
 * DataFast page analytics.
 *
 * The website id is a public identifier: it ships in the bundle by design and
 * is not a credential, so it lives here rather than in the environment.
 *
 * Nothing is tracked on localhost. `allowLocalhost` defaults to false in the
 * SDK and is left that way deliberately, so a fortnight of development does not
 * arrive in the same numbers as the auction.
 */

const WEBSITE_ID = "dfid_YVAG5JZvIjS22GuMeveqq";

/**
 * React runs effects twice in development under StrictMode, and a bfcache
 * restore can mount this again. One init per document is what the SDK expects,
 * so the guard is module scope rather than a ref.
 */
let started = false;

export default function Analytics() {
  useEffect(() => {
    if (started) return;
    started = true;

    void (async () => {
      try {
        const { initDataFast } = await import("datafast");
        await initDataFast({
          websiteId: WEBSITE_ID,
          // The board is a single page the visitor navigates within, so route
          // changes have to be captured explicitly: without this only the first
          // load of the tab would ever count.
          autoCapturePageviews: true,
        });
      } catch {
        // Analytics is not worth a broken page. A blocked request, an ad
        // blocker or an offline visitor all land here and are all fine.
        started = false;
      }
    })();
  }, []);

  return null;
}
