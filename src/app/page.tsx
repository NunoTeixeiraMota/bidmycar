import Image from "next/image";
import Link from "next/link";
import AuctionBoard from "@/components/AuctionBoard";
import Reveal from "@/components/Reveal";
import { AUCTION, CAR, SPOTS, metricsFor } from "@/config/car";
import { getAuctionState } from "@/lib/auction";
import { formatMoney } from "@/lib/money";
import type { AuctionState } from "@/lib/types";

// Prices, holders and clocks are live; nothing on this page may be cached.
export const dynamic = "force-dynamic";

const cheapestFloorCents = Math.min(...SPOTS.map((spot) => metricsFor(spot).floorPriceCents));

const DETAILS = [
  {
    src: "/car/vents.jpg",
    alt: "The rear quarter vents of the Datsun 100A",
    caption:
      "The C-pillar vents. Nissan put them on a shopping car in 1974 because the fastback needed to look like it had a reason to be one.",
  },
  {
    src: "/car/wheel.jpg",
    alt: "A steel wheel and hubcap on the Datsun 100A",
    caption:
      "Twelve-inch steel wheels, original hubcaps, and tyres narrower than the ones on a modern hatchback's spare.",
  },
  {
    src: "/car/rear.jpg",
    alt: "The rear panel and tail lights of the Datsun 100A",
    caption:
      "The tailgate, and the DATSUN 100A script above the bumper. What the car behind you reads at every set of lights.",
  },
] as const;

const FAQ = [
  {
    q: "What happens if someone outbids me?",
    a: "You lose the spot at that moment and every cent you paid is refunded to the card you paid with, automatically. You do not have to ask for it and nothing is deducted — not our costs, not Stripe's fee on the original charge. The refund leaves us immediately; your bank takes the usual five to ten working days to show it.",
  },
  {
    q: "When is my card charged?",
    a: "Immediately, at the moment you bid. It is a real charge through Stripe Checkout, not a hold and not a deposit. Stripe releases an uncaptured authorisation after about seven days and this auction runs for twelve, so a hold would quietly evaporate on everyone who bid in the first five days. Charging up front is the only version of this that works.",
  },
  {
    q: "What actually happens to my logo?",
    a: "A person looks at it — every upload, before it goes anywhere near the car. If it passes, it is printed or cut in removable cast vinyl and applied by hand to the panel you won. Cast vinyl is wrap material: it comes off with heat and leaves sound paint alone. Your artwork stays on for twelve months.",
  },
  {
    q: "Can I take my logo off early?",
    a: "Yes, whenever you like — email us and it comes off. There is no refund for the unexpired time, because you bought the position and you are asking us to stop using it.",
  },
  {
    q: "What if the car is sold, crashed or written off?",
    a: "If a panel carrying your artwork is damaged, we re-apply the artwork to the repaired panel at our cost. If the car is written off or stolen before your twelve months are up, we refund the unexpired proportion, pro rata by month. If we sell the car, the sale is made subject to your artwork staying on it — otherwise we refund you pro rata and remove the vinyl first.",
  },
  {
    q: "Why does each spot cost what it does?",
    a: "The opening price of every spot is what it genuinely costs to put a logo there: artwork setup, the vinyl itself, and the labour to lay it on that particular panel — a compound-curved wing takes longer than a flat door skin. Nothing above cost is asked at the floor. Everything above it is the auction pricing prominence, which is not our judgement to make.",
  },
] as const;

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
      {/* ------------------------------------------------------------ hero */}
      <section id="top" className="scroll-mt-16 pt-16 sm:pt-24">
        <div className="shell">
          <div className="mx-auto max-w-[720px] text-center">
            <p className="eyebrow">{CAR.subtitle}</p>
            <h1 className="display-xl mt-5 text-ink">
              Your logo,
              <br />
              on my Datsun.
            </h1>
            <p className="lede mx-auto mt-7 max-w-[560px]">
              Eleven spots on a 1974 Datsun 100A. You bid on one. Whoever is holding it when the
              clock stops gets their logo cut in vinyl and put on the real car.
            </p>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <a href="#spots" className="btn btn-primary btn-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                Pick a spot
              </a>
              <Link href="/how-it-works" className="btn btn-secondary btn-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                How it works
              </Link>
            </div>
          </div>
        </div>

        <div className="shell-wide mt-12 sm:mt-16">
          <Image
            src={CAR.photo}
            alt={`${CAR.name} in profile — ${CAR.subtitle}`}
            width={CAR.photoWidth}
            height={CAR.photoHeight}
            priority
            sizes="(max-width: 1440px) 100vw, 1440px"
            className="h-auto w-full"
          />
        </div>

        <div className="shell">
          <dl className="hairline-t mx-auto mt-10 grid max-w-[880px] grid-cols-2 gap-y-8 py-10 text-center sm:grid-cols-4">
            {[
              { label: "Spots", value: String(state.spotsTotal) },
              { label: "Opening from", value: formatMoney(cheapestFloorCents) },
              { label: "Runs for", value: `${AUCTION.durationHours / 24} days` },
              { label: "Outbid?", value: "Refunded" },
            ].map((item) => (
              <div key={item.label}>
                <dt className="text-[12px] uppercase tracking-[0.08em] text-faint">
                  {item.label}
                </dt>
                <dd className="tabular mt-2 text-[22px] font-semibold tracking-[-0.02em] text-ink">
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ----------------------------------------------------------- board */}
      <AuctionBoard initialState={state} />

      {/* ------------------------------------------------------------- how */}
      {/* The nav links at #how-it-works; the section itself is #how. */}
      <span id="how-it-works" aria-hidden="true" />
      <section id="how" aria-labelledby="how-heading" className="section hairline-t scroll-mt-16">
        <div className="shell">
          <Reveal>
            <div className="mx-auto max-w-[640px] text-center">
              <p className="eyebrow">How it works</p>
              <h2 id="how-heading" className="display-lg mt-4 text-ink">
                Bid. Hold. Wear it.
              </h2>
              <p className="lede mt-5">
                Eleven separate auctions running side by side, each on its own panel and its own
                clock. Nothing you do to the door affects the roof.
              </p>
            </div>
          </Reveal>

          <div className="mt-16 grid gap-px overflow-hidden rounded-[20px] bg-hairline sm:grid-cols-3">
            {[
              {
                step: "01",
                title: "Pick a panel and pay",
                body: "Choose a spot, name your amount, pay through Stripe. Your card is charged there and then — this is not a hold.",
              },
              {
                step: "02",
                title: "Hold it, or get your money back",
                body: "You hold the spot until somebody pays more for it. The moment they do, the spot is theirs and your payment is refunded in full, automatically.",
              },
              {
                step: "03",
                title: "It goes on the car",
                body: "Hold the spot when its clock stops and you have won it. Upload a logo, a human checks it, and it is cut in removable vinyl and applied to the panel.",
              },
            ].map((card, index) => (
              <Reveal key={card.step} delay={index * 90}>
                <div className="h-full bg-canvas p-8 sm:p-9">
                  <p className="tabular text-[13px] font-medium text-signal">{card.step}</p>
                  <h3 className="mt-4 text-[20px] font-semibold tracking-[-0.018em] text-ink">
                    {card.title}
                  </h3>
                  <p className="mt-3 text-[15px] leading-[1.55] text-muted">{card.body}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <div className="mt-12 text-center">
            <Link href="/how-it-works" className="btn btn-secondary btn-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              The long version
            </Link>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- the car */}
      <section
        id="the-car"
        aria-labelledby="the-car-heading"
        className="section hairline-t scroll-mt-16 bg-haze"
      >
        <div className="shell">
          <Reveal>
            <div className="max-w-[640px]">
              <p className="eyebrow">The car</p>
              <h2 id="the-car-heading" className="display-lg mt-4 text-ink">
                A 1974 Datsun 100A, still going.
              </h2>
              <div className="mt-6 space-y-4 text-[17px] leading-[1.6] text-muted">
                <p>
                  The Cherry E10 was Nissan&rsquo;s first front-wheel-drive car: 988cc, four
                  cylinders, 3.83 metres of it end to end, and about 620 kilos. This one is the
                  two-door coupé, the fastback with the odd little vents behind the rear windows.
                </p>
                <p>
                  Fifty-one years later it starts, it passes its test, and it does the school run.
                  It is not a concours car and it is not pretending to be one. It is a small red
                  Japanese saloon that someone kept going, which is a rarer thing than a restored
                  one.
                </p>
                <p>
                  Which is the whole reason this works. Nobody looks twice at a wrapped van. People
                  look twice at this, and then they read whatever is written on the door.
                </p>
              </div>
            </div>
          </Reveal>

          <div className="mt-16 grid gap-8 sm:grid-cols-3">
            {DETAILS.map((detail, index) => (
              <Reveal key={detail.src} delay={index * 90}>
                <figure>
                  <div className="overflow-hidden rounded-[18px] bg-canvas">
                    <Image
                      src={detail.src}
                      alt={detail.alt}
                      width={1200}
                      height={900}
                      sizes="(max-width: 640px) 100vw, 33vw"
                      className="h-auto w-full"
                    />
                  </div>
                  <figcaption className="mt-4 text-[14px] leading-[1.55] text-muted">
                    {detail.caption}
                  </figcaption>
                </figure>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- faq */}
      <section id="faq" aria-labelledby="faq-heading" className="section hairline-t scroll-mt-16">
        <div className="shell">
          <Reveal>
            <div className="mx-auto max-w-[640px] text-center">
              <p className="eyebrow">Questions</p>
              <h2 id="faq-heading" className="display-lg mt-4 text-ink">
                The awkward ones first.
              </h2>
            </div>
          </Reveal>

          <div className="mx-auto mt-14 max-w-[720px]">
            {FAQ.map((item, index) => (
              <Reveal key={item.q} delay={index * 60}>
                <div className="hairline-t py-9">
                  <h3 className="text-[20px] font-semibold tracking-[-0.018em] text-ink">
                    {item.q}
                  </h3>
                  <p className="mt-3 text-[16px] leading-[1.65] text-muted">{item.a}</p>
                </div>
              </Reveal>
            ))}

            <div className="hairline-t pt-9 text-[15px] leading-[1.6] text-muted">
              <p>
                Anything else, ask before you bid &mdash;{" "}
                <a
                  href="mailto:hello@brandmydatsun.com"
                  className="rounded-sm text-signal hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
                >
                  hello@brandmydatsun.com
                </a>
                . The full conditions are on the{" "}
                <Link
                  href="/terms"
                  className="rounded-sm text-signal hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
                >
                  terms page
                </Link>
                .
              </p>
            </div>
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
            Everything is installed and running &mdash; there are just no spots in the database. One
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
            <Link href="/how-it-works" className="btn btn-secondary btn-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              How the auction works
            </Link>
            <Link href="/terms" className="btn btn-secondary btn-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              Conditions
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
