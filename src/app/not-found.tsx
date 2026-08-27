import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import { CAR } from "@/config/car";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="section">
      <div className="shell">
        <div className="mx-auto max-w-[640px] text-center">
          <p className="eyebrow">Error 404</p>
          <h1 className="display-lg mt-4 text-ink">This panel isn&rsquo;t on the car.</h1>
          <p className="lede mx-auto mt-5 max-w-[34rem]">
            The page you asked for doesn&rsquo;t exist. The {CAR.name} does, and eleven spots on it
            are still up for auction.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Link href="/#spots" className="btn btn-primary btn-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              See the spots
            </Link>
            <Link href="/how-it-works" className="btn btn-secondary btn-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
              How it works
            </Link>
          </div>
        </div>

        <div className="mx-auto mt-16 max-w-[880px]">
          <Image
            src={CAR.photo}
            alt={`${CAR.name} in profile — ${CAR.subtitle}`}
            width={CAR.photoWidth}
            height={CAR.photoHeight}
            sizes="(max-width: 900px) 100vw, 880px"
            className="h-auto w-full"
          />
        </div>
      </div>
    </main>
  );
}
