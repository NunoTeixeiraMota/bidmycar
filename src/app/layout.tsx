import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Analytics from "@/components/Analytics";
import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import { CAR } from "@/config/car";

/* The two faces the design tokens expect: --font-inter backs --font-display,
   --font-mono-face backs --font-mono (see globals.css @theme). */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono-face",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

const SITE_NAME = "Brand My Datsun";
const DESCRIPTION =
  "Eleven regions of a 1974 Datsun 100A are sold as advertising space. Bid on a spot, " +
  "hold it until the clock stops, and your logo is cut in vinyl and applied to the real car. " +
  "Bids are payments, and they are not refunded if you are outbid.";

// Relative OG paths are resolved against this; without it Next emits a build
// warning and social crawlers get a broken image URL.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${SITE_NAME}: advertising space on a 1974 Datsun 100A`,
    template: `%s · ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "Datsun 100A",
    "advertising space",
    "sticker auction",
    "vinyl graphics",
    "sponsor a car",
  ],
  authors: [{ name: SITE_NAME }],
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: siteUrl,
    title: `${SITE_NAME}: eleven spots on a ${CAR.name}`,
    description: DESCRIPTION,
    locale: "en_IE",
    images: [
      {
        url: CAR.photo,
        width: CAR.photoWidth,
        height: CAR.photoHeight,
        alt: `A red ${CAR.subtitle.split(" · ")[0]} ${CAR.name} photographed in profile`,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME}: eleven spots on a ${CAR.name}`,
    description: DESCRIPTION,
    images: [CAR.photo],
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, address: false, email: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
  colorScheme: "light",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // scroll-pt clears the 48px sticky nav so an in-page anchor does not land
      // its heading underneath the bar.
      className={`${inter.variable} ${mono.variable} h-full scroll-pt-16 antialiased`}
    >
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        <a
          href="#content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <Nav />
        {/* A plain wrapper, not <main>: each page supplies its own landmark. */}
        <div id="content" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </div>
        <Footer />
        <Analytics />
      </body>
    </html>
  );
}
