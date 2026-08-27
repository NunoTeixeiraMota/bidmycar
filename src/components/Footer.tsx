import Link from "next/link";
import { CAR } from "@/config/car";

const LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/how-it-works", label: "How it works" },
  { href: "mailto:hello@brandmydatsun.com", label: "Contact" },
] as const;

export default function Footer() {
  return (
    <footer className="hairline-t bg-haze text-[12px] leading-[1.6] text-faint">
      <div className="shell py-12">
        <div className="max-w-[640px] space-y-3">
          <p>
            A bid is a payment, not a hold. Your card is charged at the moment you bid, because a
            Stripe authorisation lapses after about seven days and this auction runs for twelve.
          </p>
          <p>
            If someone outbids you on a spot, you lose the spot and your payment is refunded
            automatically to the card you paid with — you do not need to ask. Refunds settle back to
            your bank in the usual five to ten working days.
          </p>
          <p>
            Whoever holds a spot when its clock stops has their artwork cut in removable cast vinyl
            and applied to that panel of the real {CAR.name}. Vinyl is removable and does not damage
            the paint underneath. All artwork is reviewed by a human before it goes on the car, and
            we may reject anything we would not want to drive around in.
          </p>
        </div>

        <div className="hairline-t mt-10 flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="rounded-sm transition-colors duration-200 ease-showroom hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>

          <p>
            © {new Date().getFullYear()} Brand My Datsun. Not affiliated with Nissan or Datsun.
          </p>
        </div>
      </div>
    </footer>
  );
}
