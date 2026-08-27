# Brand My Datsun

Regions of a 1974 Datsun 100A are sold as advertising spots. You bid on a spot;
if you're still holding it when the clock stops, your logo is cut in vinyl and
applied to the real car.

The car itself is not for sale.

Modelled on [brandmymac.com](https://brandmymac.com) and outbid.lol, which do
the same thing with sticker spots on a MacBook. The interface follows the Apple
product-page idiom those sites borrow: near-white canvas, large light display
type, the product photographed on a clean ground.

Deploying it? Read [DEPLOY.md](./DEPLOY.md) first. This app cannot run on
Vercel, and the reasons are worth knowing before you pick a host.

---

## Quick start

```bash
npm install
npm run seed      # creates data/auction.db and opens every spot for 12 days
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
npm test                     # engine and upload-validation tests
npm run build                # production build
npm start                    # production server
npm run seed:reset           # wipe all bids, bidders and artwork; reopen every spot
npm run spots:export         # write the live board layout back into the config
npm run lint                 # eslint
```

---

## How it works

### One auction per spot, one clock for all of them

Every spot has its own price and its own bid history: parallel single-item
auctions sharing a page, not one auction with line items. What happens on the
door does not touch the roof.

They all close at the same moment. `npm run seed` gives every spot the same
deadline, and a spot added later in the admin console inherits it rather than
starting a clock of its own.

### You pay when you bid, and you do not get it back

A bid is a real charge through Stripe Checkout, not a hold. If someone outbids
you, you lose the spot and the money stays with us.

Charging up front is forced by the calendar rather than chosen. Stripe releases
an uncaptured card authorisation after roughly seven days and this auction runs
for twelve, so an authorise-now-capture-later design would silently drop every
hold placed in the first five days.

> **The engine does not match this yet.** `closeAuction` still reports displaced
> bids as owed a refund and `/api/admin/close` still issues them through Stripe.
> The site copy, the terms page and this README describe the intended model;
> reconcile `src/lib/auction.ts` and `src/app/api/admin/close/route.ts` before
> taking real money. There is a note recording this at the top of
> `src/lib/types.ts`.

### Where the starting prices come from

Every spot opens at the same price, `AUCTION.openingPriceCents` in
`src/config/car.ts`, currently **€5**. A big flat door and a small awkward
roundel start level, and the bidding decides which is worth more.

`metricsFor()` in the same file still computes what a spot costs to produce:

```
cost = setup(€35)
     + area_sqft × €12/sqft          (printed + laminated cast vinyl)
     + (€35 + area_sqft × €45) × difficulty
```

That number no longer sets any price. It is kept, and shown in the admin spot
editor next to the opening price, because it is worth knowing whether a winning
bid covers its own vinyl. Rates are mid-market for one-off custom vehicle
graphics: material at roughly €10 to €15/sq ft, installation from about €90 for
a small decal, shop labour at €60 to €70/hour. Difficulty scales the fitting:
flat door skin 1.0, glass 0.9, mild curvature 1.12, compound curves 1.27.

Sources: [Signature Graphics](https://signaturegraphicsinc.com/how-much-do-custom-decals-really-cost-in-2026/),
[Visual GraphX](https://visualgraphx.com/how-much-do-vehicle-decals-cost-avoid-overspending-on-your-custom-decals.html),
[Complete Graphics](https://www.completegraphics.us/post/vinyl-lettering-cost-per-square-foot),
[Signs101 trade discussion](https://www.signs101.com/threads/how-much-to-charge-per-square-inch.150266/).

### Increments

5% of the standing price, with a €10 minimum.

At a €5 floor the minimum bites hard: the opening bid is €5 and the next one is
€15. That is a deliberate consequence of a flat cheap floor, but if the jump is
too steep, `MIN_INCREMENT_CENTS` in `src/lib/money.ts` is the one number to
change.

### Anti-snipe

A bid inside the last five minutes pushes that spot's close out by five minutes,
up to 60 times, measured from the moment of the bid rather than from the old
closing time, so a flurry does not compound.

Extension is per spot. Since every spot otherwise closes together, a contested
spot in its final minutes will drift past the others, which is the intended
behaviour but does mean "everything closes at once" is true only until somebody
snipes.

### Spot geometry

Spots are stored as **percentages** of the car photograph, not pixels. The board
renders the photo in an aspect-ratio box and positions each spot with
`left: x%; top: y%`, so the overlays track the car at every viewport width with
no JavaScript measuring anything.

There are two sources for those percentages, in order:

1. The survey in `src/config/car.ts`, measured off the photograph by hand.
2. An override on the database row, written when someone drags a spot in the
   admin console.

`definitionOf()` in `src/lib/auction.ts` resolves the two. A half-written
override falls back to the survey rather than drawing a spot at the origin.

Percentages are converted to real centimetres using the car's actual length
(3,830 mm) against the fraction of the frame it occupies, which is what makes
the size shown on each card a real measurement.

### Artwork

Uploaded logos are held outside `public/` and served through a route handler
that refuses anything not yet approved. Uploads are sniffed by magic bytes
rather than trusted by extension, and SVG, which is XML the browser executes, is
rejected outright if it contains `<script>`, event handlers, `<foreignObject>`
or `javascript:` URLs, then served with a restrictive CSP even after approval.

A human approves every logo before it appears on the car. The car is a real
object in a real street.

### The bidders roll

Under the spot leaderboard is every bid ever placed, largest first, with the
bidder's logo and an optional link to their site. Being outbid does not remove
you from it, because being outbid does not get your money back. Links are
normalised through `src/lib/link.ts`, which accepts only http and https: the
value ends up in an `href` on a public page.

---

## Admin

`/admin`, gated by the `ADMIN_TOKEN` header. **If `ADMIN_TOKEN` is unset the
admin API refuses every request with 503** rather than defaulting open. The
token is held in browser memory only, never in localStorage, and is gone when
the tab reloads.

It carries:

- **Artwork review.** The queue, with approve and reject. A rejection keeps its
  reason and the bidder is shown it.
- **The spot editor.** Drag a spot to move it, pull a handle to resize it,
  arrow keys to nudge. Rename it, change its surface type, add a new spot, or
  delete one. A spot carrying bids cannot be deleted: money and artwork point
  at it, and the people who paid can still open their receipts.
- **The ledger.** Every spot and holder, every bid.
- **Close auction now**, which settles every spot. There is no undo.

### Getting an admin layout onto a deploy

Spots moved or added in `/admin` live only in that machine's database. A fresh
deploy seeds from `src/config/car.ts` and knows nothing about them.

```bash
npm run spots:export -- --dry    # show what it would write
npm run spots:export             # rewrite src/config/car.ts
```

Then commit the config. The script replaces everything between the
`SPOTS:START` and `SPOTS:END` markers; leave those markers alone.

---

## Configuration

Copy `.env.example` to `.env.local`. Every variable is optional in development
and none of them are in production; `.env.example` documents what breaks
without each one.

```
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_TOKEN=<openssl rand -hex 32>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
AUCTION_DB_PATH=
UPLOAD_DIR=
```

Forward webhooks locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Settlement happens in the webhook, not on the Stripe return URL: a buyer who
closes the tab after paying must still get their spot.

---

## Architecture

```
src/
  config/car.ts   The car, the shipped spot survey, and the costing formula.
                  Editing this file is how you list a different vehicle.
  lib/
    types.ts      Domain contracts. All money is integer cents.
    money.ts      Formatting, parsing, increments.
    db.ts         SQLite (better-sqlite3, WAL). Schema, additive migrations,
                  typed accessors.
    auction.ts    Bidding engine: startBid, settleBid, closeAuction, and
                  definitionOf, which resolves a spot's geometry.
    spot-admin.ts Shared by the admin spot routes: reporting and re-measuring.
    stripe.ts     Checkout, refunds, webhook verification, demo path.
    uploads.ts    Artwork validation, sniffing, SVG sanitising, storage.
    link.ts       Bidder website normalising. http(s) only; this is a boundary.
    session.ts    Signed httpOnly bidder cookie (HMAC-SHA256).
  app/api/        Route handlers.
  components/     CarBoard is the signature piece: the overlay on the photo.
                  SpotGeometryEditor is its admin-side twin.
```

### Why SQLite

One machine, and settlement that must be serialisable: a bid has to read the
standing top bid and write a new one atomically, or two simultaneous buyers can
both believe they hold a spot. SQLite in WAL mode gives that in one
`transaction()` with nothing to deploy. The accessor layer is deliberately
narrow, so moving to Postgres means rewriting one file.

Every settlement re-reads the spot and its bids **inside** the transaction.
State read before the transaction opened is never trusted. Idempotency is
enforced by unique indexes on the Stripe session and payment-intent ids, not by
hoping Stripe delivers each webhook once.

It is also why this is single-node. See [DEPLOY.md](./DEPLOY.md) §1.

### Analytics

Page views go to [DataFast](https://datafa.st) from `src/components/Analytics.tsx`.
Localhost is not tracked, a blocked request fails silently, and no bidder detail
is ever sent. It is named on the privacy page.

---

## Known limits

An honest list rather than a clean one:

- **Outbid refunds contradict the copy.** See the note under "You pay when you
  bid" above. This is the one to fix first.
- **The close is manual**, triggered from `/admin`. No background scheduler
  closes spots at their deadline on its own.
- **Bid rate limiting is per-process**, an in-memory map. Useless across more
  than one instance.
- **No email.** Outbid, win, and artwork-decision notifications are not sent,
  which is a genuine gap: being outbid is currently something you only discover
  by revisiting the site.
- **Artwork and the database are on local disk**, so the app is single-node as
  written.
- **"Final look" is a flat composite**, not a perspective-correct render. Logos
  sit in their rectangles; they are not warped to the car's curvature.
- **No identity verification** beyond a working card and a reachable email.
- **A spot's key is permanent.** Renaming changes the display name only, because
  bid receipts and artwork rows hold a spot by its key.
