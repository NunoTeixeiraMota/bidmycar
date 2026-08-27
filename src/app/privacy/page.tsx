import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AUCTION } from "@/config/car";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What Brand My Datsun stores about you, why, who else sees it, and how to have it deleted.",
};

const UPDATED = "27 August 2026";

interface Clause {
  id: string;
  heading: string;
  body: ReactNode;
}

const CLAUSES: Clause[] = [
  {
    id: "what-we-store",
    heading: "1. What is stored",
    body: (
      <>
        <p>Only what running the auction actually requires:</p>
        <ul className="ml-5 list-disc space-y-2">
          <li>
            <strong className="font-medium text-ink">Your email address.</strong> Used to send you
            the receipt, the link for uploading your logo, and notice that you have been outbid and
            refunded. It is never shown publicly.
          </li>
          <li>
            <strong className="font-medium text-ink">Your display name.</strong> This one <em>is</em>{" "}
            public: it appears beside any spot you hold. Choose it accordingly; a company name is
            the intent.
          </li>
          <li>
            <strong className="font-medium text-ink">Your bids.</strong> The spot, the amount, and
            the time. Amounts are shown publicly against the spot; who placed which losing bid is
            not.
          </li>
          <li>
            <strong className="font-medium text-ink">Any logo you upload,</strong> together with its
            filename and the review decision made on it.
          </li>
          <li>
            <strong className="font-medium text-ink">A session cookie</strong> named{" "}
            <code className="rounded bg-haze px-1 py-0.5 font-mono text-[13px]">spot_bidder</code>,
            which identifies you to the site so you can bid and upload without a password. It is
            signed, so it cannot be forged, and it carries nothing but your bidder id.
          </li>
        </ul>
        <p>
          There is no analytics, no advertising pixel, and no third-party tracking script on this
          site. Nothing here is used to build a profile of you, because there is nothing to gain
          from it.
        </p>
      </>
    ),
  },
  {
    id: "card-details",
    heading: "2. Card details are not stored here",
    body: (
      <p>
        Payment is handled entirely by Stripe. Your card number never reaches this server and is
        never written to this database. The site stores only Stripe&rsquo;s identifiers for the
        customer, the payment and any refund, which are meaningless without access to the Stripe
        account. Stripe&rsquo;s own privacy notice governs what they hold.
      </p>
    ),
  },
  {
    id: "who-sees-it",
    heading: "3. Who else sees it",
    body: (
      <>
        <p>
          Stripe, for payments and refunds. The vinyl shop that cuts the winning artwork, which
          receives the logo files and nothing else: no email addresses and no bid amounts.
        </p>
        <p>
          DataFast, which counts page visits for us. It is sent the page you are on and the usual
          things a web server sees, and it is never sent your email address, your name or what you
          bid. It is measurement, not advertising, and nothing it holds identifies you to us.
        </p>
        <p>
          Nobody else. Your details are not sold, rented, shared for advertising, or passed to any
          other business.
        </p>
      </>
    ),
  },
  {
    id: "how-long",
    heading: "4. How long it is kept",
    body: (
      <>
        <p>
          Bids and payment records are kept for as long as tax and accounting rules require them,
          which in Portugal is ten years. That obligation overrides a deletion request for those
          specific records: an invoice cannot be unwritten.
        </p>
        <p>
          Rejected artwork is deleted once the decision is final. Approved artwork is kept for as
          long as it is on the car, and afterwards as part of the record of what the car carried.
        </p>
      </>
    ),
  },
  {
    id: "your-rights",
    heading: "5. Your rights",
    body: (
      <>
        <p>
          The GDPR applies. You may ask for a copy of everything held about you, ask for it to be
          corrected, ask for it to be deleted (subject to clause 4), or object to how it is used.
          Ask at{" "}
          <a
            href="mailto:hello@brandmydatsun.com"
            className="rounded-sm text-signal hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
          >
            hello@brandmydatsun.com
          </a>{" "}
          and expect an answer within thirty days.
        </p>
        <p>
          Changing your public display name is the one thing you can always have done immediately,
          for any reason, without explaining why.
        </p>
      </>
    ),
  },
  {
    id: "security",
    heading: "6. Security, honestly stated",
    body: (
      <>
        <p>
          Uploads are limited to {Math.round(AUCTION.maxLogoBytes / (1024 * 1024))} MB and checked
          by their actual file signature rather than their extension; SVGs carrying scripts or event
          handlers are rejected outright, and no uploaded file is publicly reachable until a human
          has approved it.
        </p>
        <p>
          This is a small site run by one person, not a bank. It is built carefully, but you should
          not put anything into it that you would be harmed by losing, and there is no reason to,
          since it asks for nothing beyond an email address and a logo.
        </p>
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <main>
      <section className="section hairline-b bg-haze">
        <div className="shell">
          <div className="max-w-[680px]">
            <p className="eyebrow">Privacy</p>
            <h1 className="display-lg mt-4 text-ink">What this site knows about you.</h1>
            <p className="lede mt-5">
              An email address, a display name, what you bid, and the logo you uploaded. That is the
              whole list.
            </p>
            <p className="mt-6 text-[13px] text-faint">Last updated {UPDATED}</p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="max-w-[680px]">
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
            <div className="flex flex-wrap gap-3">
              <Link
                href="/terms"
                className="btn btn-secondary btn-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                Auction conditions
              </Link>
              <Link
                href="/#spots"
                className="btn btn-primary btn-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                See the spots
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
