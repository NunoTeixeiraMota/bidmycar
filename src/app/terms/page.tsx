import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AUCTION, CAR } from "@/config/car";

export const metadata: Metadata = {
  title: "Auction conditions",
  description:
    "The conditions of the Brand My Datsun spot auction: immediate charges, no refunds " +
    "when you are outbid, artwork moderation, and how long vinyl stays on the car.",
};

const UPDATED = "27 August 2026";

interface Clause {
  id: string;
  heading: string;
  body: ReactNode;
}

const CLAUSES: Clause[] = [
  {
    id: "what-is-sold",
    heading: "1. What is being sold",
    body: (
      <>
        <p>
          The {CAR.name} is not for sale and no bid conveys any interest in it. What is sold is a
          licence to display one image on one named region of its bodywork, for the period set out
          in clause 7. There are eleven such regions and each is auctioned separately, with its own
          price, its own bid history and its own closing time.
        </p>
        <p>
          The vehicle remains owned, registered, insured and driven by us throughout. Where and how
          far it is driven is at our discretion, and no minimum mileage, route or exposure is
          promised or implied.
        </p>
      </>
    ),
  },
  {
    id: "bids",
    heading: "2. A bid is a payment",
    body: (
      <>
        <p>
          Placing a bid charges your card immediately through Stripe Checkout. It is not a hold, a
          deposit or a pre-authorisation, and there is no separate step later where you are asked to
          pay.
        </p>
        <p>
          This is a consequence of the calendar rather than a preference. Stripe releases an
          uncaptured card authorisation after roughly seven days; this auction runs for twelve. Any
          authorise-now-capture-later arrangement would silently release every hold placed in the
          first five days, so charging at bid time is the only mechanism that survives the auction
          length.
        </p>
        <p>
          A bid is binding once payment settles. It cannot be retracted, and holding a spot is not a
          purchase of goods you may return: it is a competitive position in an auction which someone
          else may take from you at any moment before the clock stops.
        </p>
      </>
    ),
  },
  {
    id: "outbid",
    heading: "3. Being outbid",
    body: (
      <>
        <p>
          Each spot is held by exactly one bidder: whoever has paid the highest amount for it. When
          somebody pays more than you for the spot you are holding, you lose the spot at that
          moment. What you paid is not refunded, in whole or in part.
        </p>
        <p>
          This is the central term of the auction and you should read it twice before you bid. A
          bid buys you the position for as long as you can hold it, not a place in a queue with
          your money set aside. Bid only what you are willing to lose to a higher bidder.
        </p>
        <p>
          Where two bids of the same amount are received for the same spot, the earlier one holds
          it. The minimum a new bid must reach is five per cent above the standing price, or ten
          euro more, whichever is greater.
        </p>
      </>
    ),
  },
  {
    id: "closing",
    heading: "4. Closing and anti-snipe",
    body: (
      <>
        <p>
          Every spot closes at the same published time. A bid placed within the final{" "}
          {AUCTION.snipeWindowMs / 60000} minutes pushes that spot&rsquo;s closing time out by a
          further {AUCTION.extensionMs / 60000} minutes from the moment of the bid, up to{" "}
          {AUCTION.maxExtensions} times. Extending one spot does not extend any other.
        </p>
        <p>
          Whoever holds a spot when its clock stops has won it. We will email you at the address you
          bid with; if artwork has not been supplied by then, that email is the request for it.
        </p>
      </>
    ),
  },
  {
    id: "artwork",
    heading: "5. Artwork, and our right to refuse it",
    body: (
      <>
        <p>
          You must supply artwork you own or are licensed to reproduce, as PNG, SVG, JPEG or WebP,
          up to {Math.round(AUCTION.maxLogoBytes / (1024 * 1024))} MB. By uploading it you grant us
          the right to reproduce it in vinyl, apply it to the car, and photograph the car with it
          on. You keep every other right in it.
        </p>
        <p>
          A person looks at every upload before it goes anywhere near the car. We will reject
          artwork that is unlawful, that infringes somebody else&rsquo;s mark, that is hateful,
          sexual, deceptive, or that impersonates a real organisation, and we will reject artwork
          for reasons no narrower than not wanting to drive around with it. This is a car we
          park outside our home. Rejection comes with a reason and an invitation to supply something
          else.
        </p>
        <p>
          If you cannot supply artwork we are willing to apply, we will refund you in full. We will
          not refund you for changing your mind about a design we have already cut and fitted.
        </p>
      </>
    ),
  },
  {
    id: "application",
    heading: "6. How it goes on the car",
    body: (
      <>
        <p>
          Artwork is printed or cut in removable cast vinyl and applied by hand to the panel you
          won. Cast vinyl is a wrap material: it comes off with heat and does not damage sound paint
          underneath.
        </p>
        <p>
          Reproduction is limited by the medium. Colour is matched as closely as a printer and a
          fifty-year-old red car allow; very fine detail, gradients and thin strokes may be
          simplified so that they survive being cut, applied and washed. We will tell you before
          fitting if your artwork needs that treatment.
        </p>
        <p>
          The panel is the panel you bid on, at the published size, in the position shown on the
          board. Panels are not flat and are not new, and small variations of a centimetre or two
          are part of putting graphics on a real vehicle.
        </p>
      </>
    ),
  },
  {
    id: "duration",
    heading: "7. How long it stays on",
    body: (
      <>
        <p>
          Your artwork stays on the car for twelve months from the day it is fitted. We undertake to
          keep it there for that period, to keep the car in the condition it is in now, and not to
          sell the panel underneath it to anyone else during it.
        </p>
        <p>
          After twelve months the vinyl comes off and the spot may be auctioned again. You have no
          right of renewal, and no right to be offered it first.
        </p>
      </>
    ),
  },
  {
    id: "removal",
    heading: "8. Removal before the twelve months are up",
    body: (
      <>
        <p>
          You may ask us to take your artwork off at any time, and we will. There is no refund for
          the unexpired period: you bought the position, and you are asking us to stop using it.
        </p>
        <p>
          We may also remove artwork ourselves if we later learn it infringes a third party&rsquo;s
          rights, if a court or authority tells us to, or if it turns out to be something we would
          have rejected had we understood it at review. In that case we refund the unexpired
          proportion of what you paid, pro rata by month.
        </p>
      </>
    ),
  },
  {
    id: "damage",
    heading: "9. If the car is damaged, written off, or sold",
    body: (
      <>
        <p>
          It is a fifty-year-old car in daily use. If a panel carrying your artwork is damaged, we
          will have the artwork re-applied to the repaired or replacement panel at our cost as soon
          as is practical.
        </p>
        <p>
          If the car is written off, stolen and not recovered, or otherwise ends its life before
          your twelve months are up, we refund the unexpired proportion of what you paid, pro rata
          by month. That is the whole of our liability for it.
        </p>
        <p>
          If we sell the car, your licence goes with it: any sale is made subject to the artwork
          staying on the vehicle for the remainder of your term. If a buyer will not accept that, we
          do not sell, or we refund you pro rata and remove the vinyl first.
        </p>
      </>
    ),
  },
  {
    id: "liability",
    heading: "10. Liability",
    body: (
      <>
        <p>
          What you are owed if we get this wrong is the money you paid us, refunded. We are not
          liable for indirect or consequential loss, for lost profit, or for advertising outcomes
          because nobody is promising you impressions, clicks, leads or anything measurable. You are
          buying a sticker on a small red car.
        </p>
        <p>
          Nothing here limits liability that cannot lawfully be limited, including for death or
          personal injury caused by negligence, or for fraud.
        </p>
      </>
    ),
  },
  {
    id: "data",
    heading: "11. Your details",
    body: (
      <>
        <p>
          We store the email address and display name you bid with, your bid history, and your
          artwork. Card details are handled by Stripe and never reach our servers. Your display name
          appears publicly beside the spots you hold; your email address does not.
        </p>
        <p>
          Write to us and we will delete what we hold, save for the records of payments and refunds
          we are obliged to keep.
        </p>
      </>
    ),
  },
  {
    id: "law",
    heading: "12. Governing law",
    body: (
      <>
        <p>
          These conditions, the auction, and anything arising out of either are governed by
          Portuguese law. The courts of Portugal have exclusive jurisdiction.
        </p>
        <p>
          If you are a consumer resident elsewhere in the European Union, this does not deprive you
          of the protection of the mandatory rules of your own country of residence.
        </p>
      </>
    ),
  },
];

export default function TermsPage() {
  return (
    <main>
      <section className="section hairline-b bg-haze">
        <div className="shell">
          <div className="max-w-[680px]">
            <p className="eyebrow">Auction conditions</p>
            <h1 className="display-lg mt-4 text-ink">The terms you bid under.</h1>
            <p className="lede mt-5">
              Short version: your card is charged the second you bid, you get every cent back
              automatically the second someone outbids you, a human checks your logo, and it stays
              on the car for a year.
            </p>
            <p className="mt-6 text-[13px] text-faint">Last updated {UPDATED}</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <nav aria-label="Conditions" className="max-w-[680px]">
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-faint">Contents</h2>
            <ol className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
              {CLAUSES.map((clause) => (
                <li key={clause.id}>
                  <a
                    href={`#${clause.id}`}
                    className="rounded-sm text-[14px] text-muted transition-colors duration-200 ease-showroom hover:text-signal focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
                  >
                    {clause.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="mt-16 max-w-[680px]">
            {CLAUSES.map((clause) => (
              <article key={clause.id} id={clause.id} className="hairline-t scroll-mt-20 py-10">
                <h2 className="display-md text-ink">{clause.heading}</h2>
                <div className="mt-5 space-y-4 text-[16px] leading-[1.65] text-muted">
                  {clause.body}
                </div>
              </article>
            ))}
          </div>

          <div className="hairline-t mt-4 max-w-[680px] pt-10">
            <p className="text-[15px] text-muted">
              Something here unclear? Ask before you bid:{" "}
              <a
                href="mailto:hello@brandmydatsun.com"
                className="rounded-sm text-signal hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
              >
                hello@brandmydatsun.com
              </a>
              .
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/#spots" className="btn btn-primary btn-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                See the spots
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
