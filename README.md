# Brand My Datsun

Eleven regions of a 1974 Datsun 100A are sold as advertising spots. You bid on a
spot; if you're still holding it when the clock stops, your logo is cut in vinyl
and applied to the real car.

The car itself is not for sale.

Modelled on [brandmymac.com](https://brandmymac.com) and outbid.lol, which do
the same thing with sticker spots on a MacBook. The interface follows the Apple
product-page idiom those sites borrow: near-white canvas, large light display
type, the product photographed on a clean ground.

---

## Quick start

```bash
npm install
npm run seed      # creates data/auction.db and opens the 11 spots for 12 days
npm run dev       # http://localhost:3000
```

To see the board populated rather than empty, with the app running in another
terminal:

```bash
npm run seed:demo   # seven spots taken, logos uploaded and approved
```

It drives the real HTTP API rather than writing behind the app's back, so it
exercises the same bidding, upload and review paths a visitor would.

**It runs without a Stripe account.** With no keys configured the app starts in
*demo mode*: a bid settles immediately without taking money, so you can exercise
the whole auction the moment you unzip it. Add keys when you want real charges.

```bash
npm test            # engine and upload-validation tests
npm run build       # production build
npm start           # production server
npm run seed:reset  # wipe all bids, bidders and artwork; reopen every spot
npm run lint        # eslint
```

---

## How it works

### One auction per spot

Each of the eleven spots has its own price, its own bid history, and its own
closing time. It is eleven parallel single-item auctions sharing one page, not
one auction with eleven line items. Extending one spot's clock does not touch
the others.

### You pay when you bid

A bid is a real charge through Stripe Checkout, not a hold. If someone outbids
you, you are refunded in full, automatically.

This is forced by the calendar rather than chosen. Stripe releases an uncaptured
card authorisation after roughly seven days, and this auction runs for twelve —
an authorise-now-capture-later design would silently drop every hold placed in
the first five days. Charging up front is the only model that survives a
twelve-day auction, and it is why the reference site can show a running "raised"
total at all.

The cost is refund churn: an actively contested spot generates a refund per
displacement. That is a real fee cost on Stripe and it is the honest trade.

### Where the starting prices come from

Every spot opens at what it actually costs to put a logo there — nothing more.
Prominence is priced by the bidding, not by us.

The floor is computed in `src/config/car.ts`, not typed in by hand:

```
floor = setup(€35)
      + area_sqft × €12/sqft          (printed + laminated cast vinyl)
      + (€35 + area_sqft × €45) × difficulty
```

Rates are mid-market for one-off custom vehicle graphics: material at roughly
€10–15/sq ft, installation from about €90 for a small decal, shop labour at
€60–70/hour. Difficulty scales the fitting: flat door skin 1.0, glass 0.9, mild
curvature 1.12, compound curves 1.27. The result is rounded to the nearest €5,
because a floor price of "€117.43" reads as a machine guessing rather than a
shop quoting.

Sources: [Signature Graphics](https://signaturegraphicsinc.com/how-much-do-custom-decals-really-cost-in-2026/),
[Visual GraphX](https://visualgraphx.com/how-much-do-vehicle-decals-cost-avoid-overspending-on-your-custom-decals.html),
[Complete Graphics](https://www.completegraphics.us/post/vinyl-lettering-cost-per-square-foot),
[Signs101 trade discussion](https://www.signs101.com/threads/how-much-to-charge-per-square-inch.150266/).

That gives, for this car:

| Spot | Size | Floor |
|---|---|---|
| Door panel | 58 × 24 cm | €155 |
| Front wing | 43 × 19 cm | €140 |
| Rear quarter | 43 × 18 cm | €135 |
| Rocker banner | 116 × 8 cm | €135 |
| Front lower wing | 30 × 13 cm | €110 |
| Quarter glass | 43 × 15 cm | €105 |
| Roof | 56 × 8 cm | €105 |
| Tailgate | 30 × 10 cm | €100 |
| Rear lower quarter | 26 × 11 cm | €100 |
| Bonnet | 30 × 10 cm | €95 |
| Racing roundel | 18 × 11 cm | €90 |

Eleven spots, €1,270 at the floor.

### Increments

5% of the standing price, with a €10 minimum. A fixed ladder tuned for a
five-figure car would be meaningless at these prices.

### Anti-snipe

A bid inside the last five minutes pushes that spot's close out by five minutes,
up to 60 times. The extension is measured from the moment of the bid, not from
the old closing time, so a flurry of bids does not compound.

### Spot geometry

Spots are stored as **percentages** of the car photograph, not pixels
(`src/config/car.ts`). The board renders the photo in an aspect-ratio box and
positions each spot with `left: x%; top: y%`, so the overlays track the car at
every viewport width with no JavaScript measuring anything.

Those percentages are converted to real centimetres using the car's actual
length (3,830 mm) against the fraction of the frame it occupies — which is what
makes the price formula produce real money rather than arbitrary numbers.

### Artwork

Uploaded logos are held outside `public/` and served through a route handler
that refuses anything not yet approved. Uploads are sniffed by magic bytes
rather than trusted by extension, and SVG — which is XML the browser executes —
is rejected outright if it contains `<script>`, event handlers, `<foreignObject>`
or `javascript:` URLs, then served with a restrictive CSP even after approval.

A human approves every logo before it appears on the car. The car is a real
object in a real street.

---

## Admin

`/admin` is a plain working console: spots and holders, the bid ledger, the
artwork review queue, and a **Close auction now** button that settles every
spot and issues outstanding refunds.

Gated by the `ADMIN_TOKEN` header. **If `ADMIN_TOKEN` is unset the admin API
refuses every request with 503** rather than defaulting open.

---

## Configuration

Copy `.env.example` to `.env.local`:

```
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_TOKEN=<openssl rand -hex 32>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

Forward webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Settlement happens in the webhook, not on the Stripe return URL — a buyer who
closes the tab after paying must still get their spot.

---

## Architecture

```
src/
  config/car.ts   The car, the eleven spots, and the pricing formula.
                  Editing this file is how you list a different vehicle.
  lib/
    types.ts      Domain contracts. All money is integer cents.
    money.ts      Formatting, parsing, increments.
    db.ts         SQLite (better-sqlite3, WAL). Schema + typed accessors.
    auction.ts    Bidding engine: startBid, settleBid, closeAuction.
    stripe.ts     Checkout, refunds, webhook verification, demo path.
    uploads.ts    Artwork validation, sniffing, SVG sanitising, storage.
    session.ts    Signed httpOnly bidder cookie (HMAC-SHA256).
  app/api/        Route handlers.
  components/     CarBoard is the signature piece — the overlay on the photo.
```

### Why SQLite

Eleven spots, one machine, and settlement that must be serialisable: a bid has
to read the standing top bid and write a new one atomically, or two simultaneous
buyers can both believe they hold a spot. SQLite in WAL mode gives that in one
`transaction()` with nothing to deploy. The accessor layer is deliberately
narrow, so moving to Postgres means rewriting one file.

Every settlement re-reads the spot and its bids **inside** the transaction.
State read before the transaction opened is never trusted. Idempotency is
enforced by unique indexes on the Stripe session and payment-intent ids, not by
hoping Stripe delivers each webhook once.

---

## Known limits

An honest list rather than a clean one:

- **The close is manual**, triggered from `/admin`. No background scheduler
  closes spots at their deadline on its own.
- **Refund churn is real.** A hotly contested spot generates a Stripe refund per
  displacement, and Stripe's fees on the original charge are not returned.
- **Bid rate limiting is per-process**, an in-memory map. Useless across more
  than one instance.
- **No email.** Outbid, win, and artwork-decision notifications are not sent —
  which is a genuine gap, since being outbid is currently something you only
  discover by revisiting the site.
- **Artwork is stored on local disk**, so the app is single-node as written.
- **"Final look" is a flat composite**, not a perspective-correct render. Logos
  sit in their rectangles; they are not warped to the car's curvature.
- **No identity verification** beyond a working card and a reachable email.
