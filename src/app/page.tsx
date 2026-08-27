import Image from "next/image";
import Link from "next/link";
import AuctionBoard from "@/components/AuctionBoard";
import Countdown from "@/components/Countdown";
import { AUCTION, CAR, SPOTS } from "@/config/car";
import { getAuctionState } from "@/lib/auction";
import type { AuctionState } from "@/lib/types";

// Prices, holders and clocks are live; nothing on this page may be cached.
export const dynamic = "force-dynamic";

const DETAILS = [
  { src: "/car/vents.jpg", alt: "The rear quarter vents of the Datsun 100A" },
  { src: "/car/wheel.jpg", alt: "A steel wheel and hubcap on the Datsun 100A" },
  { src: "/car/rear.jpg", alt: "The rear panel and tail lights of the Datsun 100A" },
] as const;

/** Every spot closes together, so the auction has exactly one deadline and the
 *  page shows exactly one clock. */
const DEADLINE_FORMAT = new Intl.DateTimeFormat("en-IE", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** An unseeded install either throws or returns nothing, depending on how far
 *  the schema got. Both mean the same thing to the reader. */
async function readState(): Promise<AuctionState | null> {
  try {
    return await getAuctionState(Date.now());
  } catch {
    return null;
  }
}

export default async function Home() {
  const state = await readState();
  if (!state || state.spots.length === 0) return <SetupNotice />;

  return (
    <main>
      <section className="pt-10 sm:pt-14">
        <div className="shell-wide">
          <div className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[560px]">
              <p className="eyebrow">{CAR.subtitle}</p>
              <h1 className="display-lg mt-4 text-ink">
                Your logo,
                <br />
                on my Datsun.
              </h1>
              <p className="mt-5 max-w-[440px] text-[16px] leading-[1.55] text-muted">
                Hold one when the clock stops and your logo goes on the {CAR.name} in removable
                vinyl for twelve months.
              </p>
            </div>

            <div className="w-full lg:max-w-[400px]">
              <p className="text-[11px] uppercase tracking-[0.08em] text-faint">
                {state.allClosed ? "Bidding closed" : "Everything closes in"}
              </p>
              <Countdown className="mt-3" closesAt={state.closesAt} serverNow={state.serverNow} />
              <p className="mt-3 text-[13px] text-muted">
                <time dateTime={new Date(state.closesAt).toISOString()} className="tabular">
                  {DEADLINE_FORMAT.format(state.closesAt)}
                </time>
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="mt-12 sm:mt-14">
        <AuctionBoard initialState={state} />
      </div>

      <section
        id="the-car"
        aria-labelledby="the-car-heading"
        className="hairline-t scroll-mt-16 bg-haze py-20"
      >
        <div className="shell-wide">
          <div className="max-w-[620px]">
            <h2 id="the-car-heading" className="display-md text-ink">
              Fifty one years, and more to come.
            </h2>
            <p className="mt-4 text-[16px] leading-[1.6] text-muted">
              Advertising in the real world, not just behind a screen.
            </p>
          </div>

          <div className="mt-12 grid gap-8 sm:grid-cols-3">
            {DETAILS.map((detail) => (
              <div key={detail.src} className="overflow-hidden rounded-[18px] bg-canvas">
                <Image
                  src={detail.src}
                  alt={detail.alt}
                  width={1200}
                  height={900}
                  sizes="(max-width: 640px) 100vw, 33vw"
                  className="h-auto w-full"
                />
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Unseeded install
 * ------------------------------------------------------------------ */

/**
 * The first thing anyone sees if they skip `npm run seed`, so it is a page
 * rather than an error: same design system, same tone, and the command they
 * are missing in large type.
 */
function SetupNotice() {
  return (
    <main className="section">
      <div className="shell">
        <div className="mx-auto max-w-[640px]">
          <p className="eyebrow">Almost there</p>
          <h1 className="display-lg mt-4 text-ink">The auction hasn&rsquo;t been opened yet.</h1>
          <p className="lede mt-5">
            Everything is installed and running. There are just no spots in the database, and one
            command creates them and starts the {AUCTION.durationHours / 24}-day clock.
          </p>

          <div className="mt-10 overflow-x-auto rounded-2xl bg-graphite p-6">
            <pre className="font-mono text-[15px] leading-[1.8] text-white">
              <span className="text-faint">$</span> npm run seed
            </pre>
          </div>

          <p className="mt-6 text-[15px] leading-[1.6] text-muted">
            That writes <code className="font-mono text-[14px]">data/auction.db</code>, opens all{" "}
            {SPOTS.length} spots at their floor prices, and sets every clock to close in{" "}
            {AUCTION.durationHours / 24} days. Then reload this page.
          </p>

          <div className="hairline-t mt-12 pt-10">
            <h2 className="text-[17px] font-semibold tracking-[-0.015em] text-ink">
              While you are here
            </h2>
            <ul className="mt-4 space-y-3 text-[15px] leading-[1.6] text-muted">
              <li>
                <span className="text-ink">No Stripe keys?</span> It still runs. With no keys
                configured the app starts in demo mode: a bid settles immediately without taking
                money, so you can exercise the whole auction now and add keys later.
              </li>
              <li>
                <span className="text-ink">Starting over?</span>{" "}
                <code className="font-mono text-[14px]">npm run seed:reset</code> wipes every bid,
                bidder and upload, and reopens all {SPOTS.length} spots.
              </li>
              <li>
                <span className="text-ink">Admin console?</span> Set{" "}
                <code className="font-mono text-[14px]">ADMIN_TOKEN</code> in{" "}
                <code className="font-mono text-[14px]">.env.local</code>, then open{" "}
                <Link
                  href="/admin"
                  className="rounded-sm text-signal hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
                >
                  /admin
                </Link>
                . Without it the admin API refuses everything with a 503 rather than defaulting
                open.
              </li>
            </ul>
          </div>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link href="/terms" className="btn btn-secondary btn-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              Conditions
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
