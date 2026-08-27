/**
 * Opens the lot: creates data/auction.db, writes the schema, and inserts the
 * eleven spots with a fresh clock.
 *
 *   node scripts/seed.mjs            create/refresh the spots
 *   node scripts/seed.mjs --reset    also wipe every bid, bidder and artwork
 *
 * The spot table and the pricing formula are NOT restated here — they are
 * imported straight out of src/config/car.ts, so a re-measured spot or a
 * changed vinyl rate can never drift between the app and the seed. Node runs
 * the TypeScript by stripping its types (built in since 22.18, behind a flag
 * from 22.6), which works only because car.ts and ids.ts import nothing that
 * needs a bundler to resolve.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import DatabaseCtor from "better-sqlite3";

// Type stripping emits a performance advisory for every .ts file it loads; it
// is noise in front of a results table. Node keeps no public "unwarn" hook, so
// the default printer is replaced by one that filters this single code.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.code !== "MODULE_TYPELESS_PACKAGE_JSON") console.error(warning.stack);
});

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESET = process.argv.includes("--reset");
const RESPAWNED = process.env.__SEED_TYPE_STRIPPING === "1";

/* ------------------------------------------------------------------ *
 * Loading the TypeScript config
 * ------------------------------------------------------------------ */

async function loadConfig() {
  try {
    const car = await import(new URL("../src/config/car.ts", import.meta.url).href);
    const ids = await import(new URL("../src/lib/ids.ts", import.meta.url).href);
    return { ...car, newId: ids.newId };
  } catch (error) {
    // Node 22.6–22.17 can strip types but only when asked, and a runtime flag
    // cannot be added to a process that has already started.
    if (RESPAWNED) throw error;

    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", ...process.argv.slice(1)],
      { stdio: "inherit", env: { ...process.env, __SEED_TYPE_STRIPPING: "1" } },
    );
    if (child.status === 0) process.exit(0);

    console.error(
      "\nseed: could not load src/config/car.ts.\n" +
        "Node must be able to run TypeScript directly — use Node 22.6 or newer.\n" +
        `This is Node ${process.version}.\n`,
    );
    process.exit(1);
  }
}

const { SPOTS, AUCTION, CAR, metricsFor, newId } = await loadConfig();

/* ------------------------------------------------------------------ *
 * Schema — kept byte-identical in intent to src/lib/db.ts, which owns it at
 * runtime. Seeding must not depend on a server having booted first.
 * ------------------------------------------------------------------ */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spots (
  id                TEXT PRIMARY KEY,
  key               TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  panel             TEXT NOT NULL,
  blurb             TEXT NOT NULL,
  floor_price_cents INTEGER NOT NULL,
  width_cm          REAL NOT NULL,
  height_cm         REAL NOT NULL,
  status            TEXT NOT NULL,
  closes_at         INTEGER NOT NULL,
  extension_count   INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bidders (
  id                 TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  stripe_customer_id TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bids (
  id                         TEXT PRIMARY KEY,
  spot_id                    TEXT NOT NULL REFERENCES spots(id),
  bidder_id                  TEXT NOT NULL REFERENCES bidders(id),
  amount_cents               INTEGER NOT NULL,
  status                     TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id   TEXT,
  stripe_refund_id           TEXT,
  created_at                 INTEGER NOT NULL,
  paid_at                    INTEGER,
  refunded_at                INTEGER,
  sequence                   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artwork (
  id               TEXT PRIMARY KEY,
  bid_id           TEXT NOT NULL REFERENCES bids(id),
  spot_id          TEXT NOT NULL,
  bidder_id        TEXT NOT NULL,
  filename         TEXT NOT NULL,
  mime_type        TEXT NOT NULL,
  byte_size        INTEGER NOT NULL,
  stored_path      TEXT NOT NULL,
  review_status    TEXT NOT NULL,
  rejection_reason TEXT,
  created_at       INTEGER NOT NULL,
  reviewed_at      INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_checkout_session
  ON bids(stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_payment_intent
  ON bids(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_spot_sequence ON bids(spot_id, sequence);
CREATE INDEX IF NOT EXISTS idx_bids_spot_rank
  ON bids(spot_id, status, amount_cents DESC, sequence ASC);
CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder_id);
CREATE INDEX IF NOT EXISTS idx_artwork_bid ON artwork(bid_id);
CREATE INDEX IF NOT EXISTS idx_artwork_review ON artwork(review_status);
`;

/* ------------------------------------------------------------------ *
 * Seed
 * ------------------------------------------------------------------ */

const dbPath = process.env.AUCTION_DB_PATH ?? join(PROJECT_ROOT, "data", "auction.db");
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseCtor(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");
db.exec(SCHEMA);

const now = Date.now();
const closesAt = now + AUCTION.durationHours * 60 * 60 * 1000;

// A re-seed re-measures the spots and restarts the clock, but leaves a spot's
// status alone: --reset is the only thing that un-sells bodywork.
const upsert = db.prepare(`
  INSERT INTO spots (id, key, name, panel, blurb, floor_price_cents, width_cm, height_cm,
                     status, closes_at, extension_count, created_at)
  VALUES (@id, @key, @name, @panel, @blurb, @floorPriceCents, @widthCm, @heightCm,
          'open', @closesAt, 0, @createdAt)
  ON CONFLICT(key) DO UPDATE SET
    name              = excluded.name,
    panel             = excluded.panel,
    blurb             = excluded.blurb,
    floor_price_cents = excluded.floor_price_cents,
    width_cm          = excluded.width_cm,
    height_cm         = excluded.height_cm,
    closes_at         = excluded.closes_at
`);

const rows = SPOTS.map((spot) => {
  const metrics = metricsFor(spot);
  return {
    id: newId("spot"),
    key: spot.key,
    name: spot.name,
    panel: spot.panel,
    blurb: spot.blurb,
    floorPriceCents: metrics.floorPriceCents,
    widthCm: metrics.widthCm,
    heightCm: metrics.heightCm,
    closesAt,
    createdAt: now,
  };
});

db.transaction(() => {
  if (RESET) {
    // Order matters: artwork references bids, bids reference bidders.
    db.exec("DELETE FROM artwork; DELETE FROM bids; DELETE FROM bidders;");
    db.exec("UPDATE spots SET status = 'open', extension_count = 0");
  }
  for (const row of rows) upsert.run(row);
})();

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const euros = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const cm = (value) => value.toFixed(1);
const pad = (value, width) => String(value).padEnd(width);
const padStart = (value, width) => String(value).padStart(width);

const keyWidth = Math.max(12, ...rows.map((row) => row.key.length));
const sizeOf = (row) => `${cm(row.widthCm)} x ${cm(row.heightCm)} cm`;
const sizeWidth = Math.max(16, ...rows.map((row) => sizeOf(row).length));

console.log(`\n${CAR.name} — ${rows.length} spots  ·  ${dbPath}`);
console.log(`Closing ${new Date(closesAt).toISOString()} (${AUCTION.durationHours / 24} days)\n`);
console.log(`  ${pad("SPOT", keyWidth)}  ${pad("SIZE", sizeWidth)}  ${padStart("FLOOR", 8)}`);
console.log(`  ${"-".repeat(keyWidth)}  ${"-".repeat(sizeWidth)}  ${"-".repeat(8)}`);

for (const row of rows) {
  const price = euros.format(row.floorPriceCents / 100);
  console.log(`  ${pad(row.key, keyWidth)}  ${pad(sizeOf(row), sizeWidth)}  ${padStart(price, 8)}`);
}

const floorTotalCents = rows.reduce((sum, row) => sum + row.floorPriceCents, 0);
console.log(`  ${"-".repeat(keyWidth)}  ${"-".repeat(sizeWidth)}  ${"-".repeat(8)}`);
console.log(
  `  ${pad("FLOOR TOTAL", keyWidth)}  ${pad("", sizeWidth)}  ` +
    `${padStart(euros.format(floorTotalCents / 100), 8)}`,
);
console.log(
  `  ${pad("GOAL", keyWidth)}  ${pad("", sizeWidth)}  ` +
    `${padStart(euros.format(AUCTION.goalCents / 100), 8)}` +
    `   (floor covers ${Math.round((floorTotalCents / AUCTION.goalCents) * 100)}%)`,
);

if (RESET) console.log("\n  --reset: bids, bidders and artwork deleted; every spot reopened.");
console.log("");

db.close();
