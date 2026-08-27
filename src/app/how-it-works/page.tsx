import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { AUCTION, CAR, SPOTS, VINYL_PRICING, metricsFor } from "@/config/car";
import { formatMoney, INCREMENT_PERCENT, MIN_INCREMENT_CENTS } from "@/lib/money";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "Eleven parallel auctions, one per panel. What you pay and when, how refunds work when you " +
    "are outbid, the artwork each spot needs, and where the starting prices come from.",
};

/** Print resolution the vinyl shop asks for. Below this, artwork is cut soft. */
const TARGET_DPI = 150;

const rows = SPOTS.map((spot) => {
  const metrics = metricsFor(spot);
  return {
    key: spot.key,
    name: spot.name,
    panel: spot.panel,
    difficulty: spot.difficulty,
    shape: spot.shape ?? "rect",
    widthCm: metrics.widthCm,
    heightCm: metrics.heightCm,
    areaSqft: metrics.areaSqft,
    floorPriceCents: metrics.floorPriceCents,
    pxWide: Math.round((metrics.widthCm / 2.54) * TARGET_DPI),
    pxHigh: Math.round((metrics.heightCm / 2.54) * TARGET_DPI),
  };
}).sort((a, b) => b.floorPriceCents - a.floorPriceCents);

const floorTotalCents = rows.reduce((sum, row) => sum + row.floorPriceCents, 0);

const DIFFICULTY_NOTE: Record<string, string> = {
  flat: "Flat panel",
  glass: "Glass",
  mild: "Mild curve",
  curved: "Compound curve",
};

function cm(value: number): string {
  return `${Math.round(value)} cm`;
}

export default function HowItWorksPage() {
  return (
    <main>
      <section className="section hairline-b bg-haze">
        <div className="shell">
          <div className="max-w-[680px]">
            <p className="eyebrow">How it works</p>
            <h1 className="display-lg mt-4 text-ink">
              Eleven auctions, one car, and no small print worth hiding.
            </h1>
            <p className="lede mt-5">
              This page is the whole mechanic: what happens when you bid, what happens when someone
              takes your spot, what your artwork has to be, and why each panel opens at the number
              it opens at.
            </p>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- mechanic */}
      <section className="section">
        <div className="shell">
          <div className="max-w-[680px] space-y-5 text-[17px] leading-[1.6] text-muted">
            <h2 className="display-md text-ink">One auction per panel</h2>
            <p>
              The {CAR.name} is not for sale. Eleven regions of its bodywork are, and each one is
              its own separate auction: its own price, its own bid history, its own clock. Nothing
              you do to the door affects the roof.
            </p>
            <p>
              You bid on a spot. If you are the highest bidder on that spot when its clock stops,
              your logo is cut in vinyl and applied to that panel of the real car. That is the whole
              product.
            </p>
            <p>
              Bidding starts at what the spot genuinely costs to make and fit. From there the price
              is whatever people are willing to pay for the position, which is the part we have no
              opinion about.
            </p>
          </div>

          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl bg-hairline sm:grid-cols-3">
            {[
              {
                step: "01",
                title: "Bid",
                body: `Pick a panel, name your amount, and pay through Stripe. The minimum raise is ${INCREMENT_PERCENT * 100}% of the standing price or ${formatMoney(MIN_INCREMENT_CENTS)}, whichever is larger.`,
              },
              {
                step: "02",
                title: "Hold",
                body: "You hold the spot until somebody pays more for it. If they do, you are refunded in full, automatically, and the spot is theirs.",
              },
              {
                step: "03",
                title: "Wear it",
                body: "Hold the spot when the clock stops and you have won it. Upload your logo, we review it, cut it, and put it on the car.",
              },
            ].map((card) => (
              <div key={card.step} className="bg-canvas p-8">
                <p className="tabular text-[13px] font-medium text-signal">{card.step}</p>
                <h3 className="mt-3 text-[19px] font-semibold tracking-[-0.018em] text-ink">
                  {card.title}
                </h3>
                <p className="mt-2.5 text-[15px] leading-[1.55] text-muted">{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ money */}
      <section className="section hairline-t bg-haze">
        <div className="shell">
          <div className="max-w-[680px] space-y-5 text-[17px] leading-[1.6] text-muted">
            <h2 className="display-md text-ink">Your card is charged when you bid</h2>
            <p>
              Not held. Not authorised. Charged. When you place a bid you are sent to Stripe
              Checkout and you pay, there and then, the full amount you bid.
            </p>
            <p>
              We would rather it were a hold, and it cannot be. Stripe releases an uncaptured card
              authorisation after about seven days, and this auction runs for{" "}
              {AUCTION.durationHours / 24} days. An authorise-now-capture-later design would quietly
              drop every hold placed in the first five days, and the first person to find out would
              be somebody who thought they had won a panel. So the money moves at bid time, and
              being outbid produces a real refund rather than a released hold.
            </p>

            <h3 className="pt-4 text-[19px] font-semibold tracking-[-0.018em] text-ink">
              Being outbid
            </h3>
            <p>
              The moment somebody pays more than you for your spot, two things happen at once: they
              become the holder, and your payment is refunded in full to the card you paid with. You
              do not ask for it and nothing is taken out of it &mdash; not our costs, not
              Stripe&rsquo;s fee on the original charge, which we absorb.
            </p>
            <p>
              The refund leaves us immediately. When it appears on your statement is your
              bank&rsquo;s decision; five to ten working days is normal, and there is nothing either
              of us can do to hurry it.
            </p>
            <p>
              You are free to bid again on the same spot straight away, and plenty of people do.
              Each bid is a separate charge and each displacement a separate refund.
            </p>

            <h3 className="pt-4 text-[19px] font-semibold tracking-[-0.018em] text-ink">
              The last five minutes
            </h3>
            <p>
              A bid placed inside the final {AUCTION.snipeWindowMs / 60000} minutes of a spot pushes
              that spot&rsquo;s closing time out by {AUCTION.extensionMs / 60000} minutes from the
              moment of the bid &mdash; up to {AUCTION.maxExtensions} times. Sniping the last second
              does not work here. Only the sniped spot moves; the other ten close on schedule.
            </p>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- artwork */}
      <section className="section hairline-t">
        <div className="shell">
          <div className="max-w-[680px] space-y-5 text-[17px] leading-[1.6] text-muted">
            <h2 className="display-md text-ink">What your artwork has to be</h2>
            <p>
              PNG, SVG, JPEG or WebP, up to{" "}
              {Math.round(AUCTION.maxLogoBytes / (1024 * 1024))} MB. Vector &mdash; SVG &mdash; is
              always best: it is what the cutter wants and it scales to the panel without softening.
            </p>
            <p>
              If you are sending a raster file, size it for the real panel. The table below gives
              every spot&rsquo;s true size in centimetres and the pixel dimensions that come out at{" "}
              {TARGET_DPI} dpi, which is what a large-format printer needs to hold an edge.
              Transparent background, please, and keep important detail away from the outer few
              millimetres.
            </p>
            <p>
              A person looks at every upload before it goes near the car. Expect a decision within a
              day. If it is rejected you get the reason and a chance to send something else; if
              nothing can be agreed, you get your money back.
            </p>
          </div>

          <div className="mt-12 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-[14px]">
              <caption className="sr-only">
                Every spot with its real size, the artwork resolution it needs, and its floor price
              </caption>
              <thead>
                <tr className="hairline-b text-[12px] uppercase tracking-[0.06em] text-faint">
                  <th scope="col" className="py-3 pr-4 font-semibold">Spot</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">Panel</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">Size</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    Artwork at {TARGET_DPI} dpi
                  </th>
                  <th scope="col" className="py-3 pr-4 font-semibold">Surface</th>
                  <th scope="col" className="py-3 text-right font-semibold">Opens at</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="hairline-b align-top">
                    <th scope="row" className="py-4 pr-4 font-medium text-ink">
                      {row.name}
                      {row.shape === "ellipse" ? (
                        <span className="ml-2 text-[12px] font-normal text-faint">circular</span>
                      ) : null}
                    </th>
                    <td className="py-4 pr-4 text-muted">{row.panel}</td>
                    <td className="tabular py-4 pr-4 text-muted">
                      {cm(row.widthCm)} &times; {cm(row.heightCm)}
                    </td>
                    <td className="tabular py-4 pr-4 text-muted">
                      {row.pxWide} &times; {row.pxHigh} px
                    </td>
                    <td className="py-4 pr-4 text-muted">{DIFFICULTY_NOTE[row.difficulty]}</td>
                    <td className="tabular py-4 text-right font-medium text-ink">
                      {formatMoney(row.floorPriceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- pricing */}
      <section className="section hairline-t bg-haze">
        <div className="shell">
          <div className="max-w-[680px] space-y-5 text-[17px] leading-[1.6] text-muted">
            <h2 className="display-md text-ink">Where the starting prices come from</h2>
            <p>
              Nothing on this site opens at a number somebody felt was about right. Each floor is
              the real cost of putting that logo on that panel: the artwork setup, the vinyl itself,
              and the labour to lay it on painted bodywork without a crease in it.
            </p>
          </div>

          <div className="mt-10 max-w-[680px] overflow-x-auto rounded-2xl border border-hairline bg-canvas p-6">
            <pre className="tabular whitespace-pre text-[13px] leading-[1.7] text-ink">
{`floor = setup (${formatMoney(VINYL_PRICING.setupEur * 100)})
      + area_sqft x ${formatMoney(VINYL_PRICING.materialEurPerSqft * 100)}/sqft      printed + laminated cast vinyl
      + (${formatMoney(VINYL_PRICING.installBaseEur * 100)} + area_sqft x ${formatMoney(VINYL_PRICING.installEurPerSqft * 100)}) x difficulty`}
            </pre>
          </div>

          <div className="mt-10 max-w-[680px] space-y-5 text-[17px] leading-[1.6] text-muted">
            <p>
              The rates are mid-market for one-off custom vehicle graphics: material around
              &euro;10&ndash;15 per square foot, installation from about &euro;90 for a small decal,
              shop labour at &euro;60&ndash;70 an hour. Difficulty scales the fitting, because a
              compound-curved wing takes materially longer than a door skin and risks a scrapped
              cut: flat {VINYL_PRICING.difficulty.flat.toFixed(2)}, glass{" "}
              {VINYL_PRICING.difficulty.glass.toFixed(2)}, mild curvature{" "}
              {VINYL_PRICING.difficulty.mild.toFixed(2)}, compound curves{" "}
              {VINYL_PRICING.difficulty.curved.toFixed(2)}.
            </p>
            <p>
              The sizes going into that formula are real. The spots are measured as percentages of
              the photograph, and the photograph is converted to centimetres against the car&rsquo;s
              actual length of {(CAR.lengthMm / 1000).toFixed(2)} m. A circular spot is billed for
              the area of the circle, not the square it sits in.
            </p>
            <p>
              The result is rounded to the nearest &euro;5, because a floor price of
              &ldquo;&euro;117.43&rdquo; reads as a machine guessing rather than a shop quoting. All
              eleven together come to {formatMoney(floorTotalCents)} at the floor &mdash; roughly
              what having the whole car resprayed would cost, which is the point.
            </p>
            <p>
              Everything above the floor is the auction pricing prominence, and that is not our
              judgement to make. The door is worth more than the rear lower quarter because people
              bid it there.
            </p>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- car */}
      <section className="section hairline-t">
        <div className="shell">
          <div className="mx-auto max-w-[1000px]">
            <Image
              src={CAR.photo}
              alt={`${CAR.name} in profile — ${CAR.subtitle}`}
              width={CAR.photoWidth}
              height={CAR.photoHeight}
              sizes="(max-width: 1000px) 100vw, 1000px"
              className="h-auto w-full"
            />
          </div>

          <div className="mx-auto mt-14 max-w-[640px] text-center">
            <h2 className="display-md text-ink">That is all of it.</h2>
            <p className="lede mt-4">
              Eleven spots, {AUCTION.durationHours / 24} days, and a fifty-year-old car that has to
              carry the result around.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link href="/#spots" className="btn btn-primary btn-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                See the spots
              </Link>
              <Link href="/terms" className="btn btn-secondary btn-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                Read the conditions
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
