# Deploying Brand My Datsun

Everything you need to put this auction on the internet and run it through to a
close. Read the first section before you pick a host: it rules some of them out.

---

## 1. What this app needs from a host

Three properties of the code decide where it can run.

**It stores its data in a SQLite file on local disk.** `data/auction.db`, in WAL
mode, opened by the process itself. There is no database server to point at.

**It stores uploaded artwork on local disk too.** `data/uploads/`, served back
through `/api/artwork/[id]/file` after a human approves it.

**It holds long-lived connections.** `/api/auction/stream` is a Server-Sent
Events endpoint that stays open and sends a heartbeat every 15 seconds.

Together those mean:

> **One long-running Node process, with a persistent disk attached.**

Concretely:

| Host style | Works? | Why |
|---|---|---|
| VPS, dedicated box, Docker with a volume | Yes | Real disk, one process |
| Fly.io, Render, Railway with a persistent volume | Yes | Same, as long as you attach a volume and run **one** instance |
| Vercel, Netlify, Lambda, Cloud Run (default) | **No** | Ephemeral or read-only filesystem; the database is lost on every deploy |
| Any host with two or more instances behind a load balancer | **No** | Two processes writing one SQLite file, or worse, two different files |

If you scale this past one instance, spots will diverge and money will be taken
against a board that no longer exists. Scaling means moving off SQLite first,
which is a different piece of work.

`better-sqlite3` is a native addon. `next.config.ts` already marks it external
so Next does not try to bundle it, but the machine that runs `npm install` must
be able to build or download a prebuilt binary for the platform it will run on.
Installing on macOS and copying `node_modules` to a Linux box will not work.

---

## 2. Requirements

- **Node 22.6 or newer.** `package.json` says `>=20.9.0`, which is enough for
  the app itself, but `npm run seed` and `npm run spots:export` read
  `src/config/car.ts` directly and need Node's TypeScript stripping.
- **A persistent volume** mounted somewhere writable.
- **A Stripe account**, unless you are deliberately running in demo mode
  (see §4).

---

## 3. Environment variables

Set these in the host's environment, not in a file you commit. `.env.local` is
git-ignored and is for your machine only.

| Variable | Required | What happens if it is missing |
|---|---|---|
| `SESSION_SECRET` | **Yes, in production** | The server **refuses to start handling sessions** and throws. This is deliberate: with a guessable secret anyone can mint a cookie for any bidder and take a spot somebody paid for. Generate with `openssl rand -hex 32`. |
| `ADMIN_TOKEN` | **Yes** | Every `/api/admin/*` route returns 503 and the console at `/admin` cannot be opened. Without it you cannot approve artwork or close the auction. Generate with `openssl rand -hex 32`. |
| `NEXT_PUBLIC_SITE_URL` | **Yes** | Stripe Checkout return URLs fall back to the incoming request's origin. Behind a proxy that can send real buyers to the wrong host. Set it to the full public origin, no trailing slash: `https://brandmydatsun.com`. |
| `STRIPE_SECRET_KEY` | For real money | The app runs in **demo mode**: bids settle instantly, no card is charged, and the bid dialog says so on screen. |
| `STRIPE_WEBHOOK_SECRET` | For real money | Webhook signatures cannot be verified, so every webhook is rejected and **no payment ever settles**. Bids stay `pending_payment` forever. |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Optional | Only needed if you render Stripe's own UI components. Checkout redirect does not need it. |
| `AUCTION_DB_PATH` | Recommended | Defaults to `<cwd>/data/auction.db`. Set it to a path on your persistent volume. |
| `UPLOAD_DIR` | Recommended | Defaults to `<cwd>/data/uploads`. Set it to a path on your persistent volume. |

Both paths must be on the volume. If you leave them at their defaults and your
volume is mounted elsewhere, the auction is wiped on every deploy.

```bash
# A complete production environment
SESSION_SECRET=<openssl rand -hex 32>
ADMIN_TOKEN=<openssl rand -hex 32>
NEXT_PUBLIC_SITE_URL=https://brandmydatsun.com
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
AUCTION_DB_PATH=/data/auction.db
UPLOAD_DIR=/data/uploads
```

`NEXT_PUBLIC_*` variables are baked into the client bundle **at build time**.
Changing `NEXT_PUBLIC_SITE_URL` requires a rebuild, not just a restart.

---

## 4. First deploy

```bash
npm ci
npm run build
npm run seed          # writes AUCTION_DB_PATH and opens every spot
npm start
```

`npm run seed` reads the spot list out of `src/config/car.ts` and creates one
row per spot, all opening at `AUCTION.openingPriceCents` (currently **€5**) and
all closing at the same moment, `AUCTION.durationHours` from now (currently
**12 days**).

Run it **once**, when you first deploy. Re-running it restarts the clock on
every spot. It does not delete bids, but it will move the deadline out from
under people who have already paid.

### Checking it worked

```bash
curl -s https://your-host/api/auction/state | head -c 200
```

You should get JSON with a `spots` array. If you get an error page, the database
is not where the app is looking.

### Demo mode

With no `STRIPE_SECRET_KEY`, everything works except the money: a bid settles
immediately without a card, and the dialog tells the visitor so. Useful for a
staging environment. Make sure it is **not** how you go live: check the admin
console header, which prints `demo mode, no real charges` in red when Stripe is
not configured.

---

## 5. Stripe

### Keys

Use live keys, not test keys. `sk_test_...` will happily take fake cards from
real people who then expect a logo on a car.

### The webhook

Settlement happens in the webhook, not on the Checkout return URL. A buyer who
closes the tab on the "thanks" screen must still get their spot, so **if the
webhook is not working, nobody ever gets what they paid for.**

Create an endpoint in the Stripe dashboard pointing at:

```
https://your-host/api/stripe/webhook
```

Subscribe it to exactly these events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.expired`
- `checkout.session.async_payment_failed`
- `payment_intent.payment_failed`
- `charge.refunded`
- `refund.updated`
- `charge.refund.updated`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and restart.

### Verifying it before you take real money

Place one bid on the deployed site with a real card, for the €5 floor. Then
check:

1. Stripe dashboard shows the payment as succeeded.
2. The Stripe webhook log shows a `200` for `checkout.session.completed`.
3. The spot shows your name as holder on the public board.
4. `/admin` lists the bid as `paid`.

If (1) succeeds but (3) does not, the webhook is the problem. A `400` in
Stripe's log means the signing secret does not match. Note that the app returns
`200` and logs a line for events it does not recognise, and for events whose
bid it cannot find, which usually means the endpoint is pointed at the wrong
environment.

---

## 6. What must survive a deploy

Two things, both on the volume:

- `AUCTION_DB_PATH` and its `-wal` / `-shm` siblings. Copy all three, or copy
  none: a `.db` without its WAL file can be missing recent writes.
- Everything under `UPLOAD_DIR`. These are the logos. The database stores the
  path, not the bytes, so losing this directory leaves rows pointing at nothing.

### Backups

```bash
sqlite3 /data/auction.db ".backup '/backups/auction-$(date +%F-%H%M).db'"
tar czf /backups/uploads-$(date +%F-%H%M).tgz -C /data uploads
```

`.backup` is safe to run against a live database; copying the file with `cp`
while the server is writing is not. Take one before every deploy and before
closing the auction.

---

## 7. Changing the board

Spots can be moved, renamed, added and deleted in `/admin`. **Those edits live
only in that machine's database.** A fresh deploy seeds from
`src/config/car.ts` and knows nothing about them.

To make the layout you arranged survive a deploy:

```bash
npm run spots:export     # reads the live database, rewrites src/config/car.ts
git add src/config/car.ts
git commit -m "Board layout as arranged in admin"
```

Run it on the machine whose database has the layout you want, then commit and
deploy. `npm run spots:export -- --dry` prints what it would write without
touching the file. The bare `--` matters: without it npm eats the flag.

The script replaces everything between the `SPOTS:START` and `SPOTS:END`
markers in `src/config/car.ts`. Do not remove those markers.

On the next `npm run seed`, a spot that has left the config is deleted from the
database, **unless it carries bids**, in which case it is kept and the seed
prints a warning. Money attached to a spot outranks the config.

---

## 8. Running the auction

### Closing it

**Nothing closes the auction automatically.** There is no cron, no scheduled
job, no timer. When the clock runs out the board shows every spot as closed and
refuses new bids, but the winners are not recorded until a human does this:

1. Open `/admin`, paste `ADMIN_TOKEN`.
2. Scroll to the close panel, type `CLOSE AUCTION` to arm the button.
3. Press it.

It marks the standing top bid on each spot as `won`. There is no undo. Take a
backup first.

### Approving artwork

Uploaded logos are **not** shown on the car until a person approves them. The
admin console lists the queue with the count in its header. A rejected upload
keeps its reason, which the bidder is shown, and they can re-upload.

Nothing emails anybody. Bidders are not told they were outbid, that they won,
or that their artwork was approved. Check the queue yourself, or tell people to
check their receipt page at `/bid/<bidId>`.

---

## 9. Redeploying

```bash
git pull
npm ci
npm run build
# do NOT run npm run seed
sudo systemctl restart brandmydatsun     # or whatever restarts your process
```

Schema changes apply themselves on the first database open: `src/lib/db.ts`
carries an additive migration that adds any missing columns. It never drops or
rewrites anything, so a rollback to the previous release keeps working against
the same file.

Restarting drops every open SSE connection. Browsers reconnect on their own and
the board repopulates from `/api/auction/state`, so this is not a problem, but
expect a visible flicker for anyone watching at that moment.

---

## 10. Proxy configuration

If you sit Nginx or similar in front of the app, the SSE endpoint needs
buffering off or the board will not update live:

```nginx
location /api/auction/stream {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
}
```

The app sends a heartbeat every 15 seconds, so any idle timeout above about 30
seconds is survivable, but a proxy that buffers will hold the whole stream and
show nothing.

`next.config.ts` already sets `X-Content-Type-Options`, `Referrer-Policy` and
`X-Frame-Options` on every response. Do not let your proxy strip them.

---

## 11. Known gaps

Things that are true today and worth knowing before you take money.

**Outbid bids are still refunded by the close job.** The site's copy says bids
are not refunded when you are outbid, and the terms page says so too. The
engine has not been changed to match: `closeAuction` still reports displaced
bids as owed a refund, and `/api/admin/close` still issues those refunds
through Stripe. Reconcile these before going live, in `src/lib/auction.ts`
(around the close routine) and `src/app/api/admin/close/route.ts`. There is a
note recording this at the top of `src/lib/types.ts`.

**No email.** Nothing is sent to anyone, ever.

**One machine.** See §1.

**The admin token is a bearer credential in a header.** Anyone who can read it
can close the auction. It is held in browser memory only, never in
localStorage, and is gone when the tab reloads. Do not paste it into a shared
machine.

---

## 12. Quick reference

| Task | Command |
|---|---|
| Install | `npm ci` |
| Build | `npm run build` |
| Start | `npm start` |
| Open the auction (once) | `npm run seed` |
| Wipe bids, reopen spots | `npm run seed:reset` |
| Fill a staging board with fake activity | `npm run seed:demo` |
| Save the admin layout into the config | `npm run spots:export` |
| Tests | `npm test` |
| Lint | `npm run lint` |

| Endpoint | Purpose |
|---|---|
| `/` | The auction |
| `/admin` | Console: artwork review, spot editor, close |
| `/bid/<bidId>` | A bidder's receipt and upload page |
| `/api/auction/state` | Board snapshot, useful as a health check |
| `/api/auction/stream` | Live updates (SSE) |
| `/api/stripe/webhook` | Stripe events |
