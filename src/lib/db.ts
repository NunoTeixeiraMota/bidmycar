import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";

import { newId } from "./ids";
import {
  LIVE_BID_STATUSES,
  type Artwork,
  type Bid,
  type BidStatus,
  type Bidder,
  type ReviewStatus,
  type Spot,
  type SpotStatus,
} from "./types";

/**
 * SQLite persistence: one handle, the schema, and typed accessors.
 *
 * Everything monetary crossing this boundary is integer cents; every timestamp
 * is epoch milliseconds stored as INTEGER. SQLite has no boolean and no date
 * type, so the mappers below are the only place row shape and domain shape are
 * allowed to disagree.
 */

/* ------------------------------------------------------------------ *
 * Handle
 * ------------------------------------------------------------------ */

function resolveDbPath(): string {
  return process.env.AUCTION_DB_PATH ?? join(process.cwd(), "data", "auction.db");
}

// Next.js re-evaluates server modules on every hot reload. A module-scoped
// singleton would therefore open a *second* handle against a WAL database on
// each edit, which is how dev servers end up throwing SQLITE_BUSY. The realm's
// global registry outlives module evaluation; the symbol keeps it unshadowable.
const HANDLE = Symbol.for("datsun-100a-auction.db");

type GlobalWithHandle = typeof globalThis & { [HANDLE]?: Database.Database };

function openDatabase(): Database.Database {
  const file = resolveDbPath();
  mkdirSync(dirname(file), { recursive: true });

  const handle = new Database(file);

  // WAL lets the SSE poller read while a bid is being written. NORMAL trades a
  // vanishingly small crash window for not fsyncing on every commit; the
  // busy_timeout is what turns a concurrent write into a short wait instead of
  // an immediate SQLITE_BUSY.
  handle.pragma("journal_mode = WAL");
  handle.pragma("foreign_keys = ON");
  handle.pragma("busy_timeout = 5000");
  handle.pragma("synchronous = NORMAL");

  migrate(handle);
  return handle;
}

export function getDb(): Database.Database {
  const g = globalThis as GlobalWithHandle;
  const existing = g[HANDLE];
  if (existing && existing.open) return existing;

  const handle = openDatabase();
  g[HANDLE] = handle;
  return handle;
}

/**
 * The raw handle, for the rare query the accessors below do not cover.
 *
 * It is a proxy rather than an eagerly-opened instance so that importing this
 * module never touches the filesystem — the first *use* opens and migrates.
 * Methods are bound to the real handle because better-sqlite3 is native code
 * and will not accept a proxy as its receiver.
 */
export const db: Database.Database = new Proxy({} as Database.Database, {
  get(_target, property) {
    const handle = getDb();
    const value = Reflect.get(handle, property) as unknown;
    return typeof value === "function" ? value.bind(handle) : value;
  },
});

/** Run `fn` atomically. Nested calls become savepoints, so composing is safe. */
export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

/* ------------------------------------------------------------------ *
 * Schema
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

-- Stripe redelivers webhooks, sometimes days later and sometimes out of order.
-- These two indexes are what make settlement idempotent in the storage layer
-- instead of in whichever handler happens to run first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_checkout_session
  ON bids(stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_payment_intent
  ON bids(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

-- Enforces the per-spot sequence invariant that ranking depends on: two bids
-- sharing a sequence would make "equal amounts, earliest wins" unresolvable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_spot_sequence ON bids(spot_id, sequence);

-- Covers the ranking query: filter by spot and status, read straight down the
-- ordering used to pick a holder.
CREATE INDEX IF NOT EXISTS idx_bids_spot_rank
  ON bids(spot_id, status, amount_cents DESC, sequence ASC);
CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids(bidder_id);
CREATE INDEX IF NOT EXISTS idx_artwork_bid ON artwork(bid_id);
CREATE INDEX IF NOT EXISTS idx_artwork_review ON artwork(review_status);
`;

function migrate(handle: Database.Database): void {
  handle.exec(SCHEMA);
}

/* ------------------------------------------------------------------ *
 * Statement cache
 * ------------------------------------------------------------------ */

// Preparing at module load would compile SQL against tables that migrate() has
// not created yet, so a mere `import` could throw. Cached on first call
// instead, keyed by source text.
const statements = new Map<string, Database.Statement<unknown[]>>();

function stmt<R = unknown>(sql: string): Database.Statement<unknown[], R> {
  const cached = statements.get(sql);
  if (cached) return cached as Database.Statement<unknown[], R>;

  const prepared = getDb().prepare<unknown[], R>(sql);
  statements.set(sql, prepared as Database.Statement<unknown[]>);
  return prepared;
}

/** SQLite binds numbers, strings, null, BigInt and Buffer; booleans it rejects. */
function bindable(value: unknown): unknown {
  return typeof value === "boolean" ? (value ? 1 : 0) : value;
}

const LIVE_STATUS_PLACEHOLDERS = LIVE_BID_STATUSES.map(() => "?").join(", ");
const LIVE_STATUS_VALUES: readonly string[] = LIVE_BID_STATUSES;

/* ------------------------------------------------------------------ *
 * Rows and mappers
 * ------------------------------------------------------------------ */

interface SpotRow {
  id: string;
  key: string;
  name: string;
  panel: string;
  blurb: string;
  floor_price_cents: number;
  width_cm: number;
  height_cm: number;
  status: string;
  closes_at: number;
  extension_count: number;
  created_at: number;
}

interface BidderRow {
  id: string;
  email: string;
  display_name: string;
  stripe_customer_id: string | null;
  created_at: number;
}

interface BidRow {
  id: string;
  spot_id: string;
  bidder_id: string;
  amount_cents: number;
  status: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  created_at: number;
  paid_at: number | null;
  refunded_at: number | null;
  sequence: number;
}

interface ArtworkRow {
  id: string;
  bid_id: string;
  spot_id: string;
  bidder_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  stored_path: string;
  review_status: string;
  rejection_reason: string | null;
  created_at: number;
  reviewed_at: number | null;
}

function toSpot(row: SpotRow): Spot {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    panel: row.panel,
    blurb: row.blurb,
    floorPriceCents: row.floor_price_cents,
    widthCm: row.width_cm,
    heightCm: row.height_cm,
    status: row.status as SpotStatus,
    closesAt: row.closes_at,
    extensionCount: row.extension_count,
    createdAt: row.created_at,
  };
}

function toBidder(row: BidderRow): Bidder {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    stripeCustomerId: row.stripe_customer_id,
    createdAt: row.created_at,
  };
}

function toBid(row: BidRow): Bid {
  return {
    id: row.id,
    spotId: row.spot_id,
    bidderId: row.bidder_id,
    amountCents: row.amount_cents,
    status: row.status as BidStatus,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    stripeRefundId: row.stripe_refund_id,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    refundedAt: row.refunded_at,
    sequence: row.sequence,
  };
}

function toArtwork(row: ArtworkRow): Artwork {
  return {
    id: row.id,
    bidId: row.bid_id,
    spotId: row.spot_id,
    bidderId: row.bidder_id,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storedPath: row.stored_path,
    reviewStatus: row.review_status as ReviewStatus,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}

/* ------------------------------------------------------------------ *
 * Patch helper
 * ------------------------------------------------------------------ */

/**
 * Builds `SET a = ?, b = ?` from a partial domain object.
 *
 * Column names come from the whitelist, never from the caller's keys, so an
 * attacker-supplied field name can only ever be ignored. `undefined` means
 * "leave alone"; an explicit `null` is written.
 */
function applyPatch<T extends object>(
  table: string,
  columns: Readonly<Record<string, string>>,
  id: string,
  patch: Partial<T>,
): boolean {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [field, value] of Object.entries(patch)) {
    const column = columns[field];
    if (column === undefined || value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(bindable(value));
  }
  if (assignments.length === 0) return false;

  values.push(id);
  const result = stmt(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return result.changes > 0;
}

const SPOT_COLUMNS: Readonly<Record<string, string>> = {
  key: "key",
  name: "name",
  panel: "panel",
  blurb: "blurb",
  floorPriceCents: "floor_price_cents",
  widthCm: "width_cm",
  heightCm: "height_cm",
  status: "status",
  closesAt: "closes_at",
  extensionCount: "extension_count",
};

const BIDDER_COLUMNS: Readonly<Record<string, string>> = {
  email: "email",
  displayName: "display_name",
  stripeCustomerId: "stripe_customer_id",
};

const BID_COLUMNS: Readonly<Record<string, string>> = {
  amountCents: "amount_cents",
  status: "status",
  stripeCheckoutSessionId: "stripe_checkout_session_id",
  stripePaymentIntentId: "stripe_payment_intent_id",
  stripeRefundId: "stripe_refund_id",
  paidAt: "paid_at",
  refundedAt: "refunded_at",
};

const ARTWORK_COLUMNS: Readonly<Record<string, string>> = {
  filename: "filename",
  mimeType: "mime_type",
  byteSize: "byte_size",
  storedPath: "stored_path",
  reviewStatus: "review_status",
  rejectionReason: "rejection_reason",
  reviewedAt: "reviewed_at",
};

/* ------------------------------------------------------------------ *
 * Spots
 * ------------------------------------------------------------------ */

const SPOT_FIELDS = `id, key, name, panel, blurb, floor_price_cents, width_cm, height_cm,
                     status, closes_at, extension_count, created_at`;

export function getSpotByKey(key: string): Spot | null {
  const row = stmt<SpotRow>(`SELECT ${SPOT_FIELDS} FROM spots WHERE key = ?`).get(key);
  return row ? toSpot(row) : null;
}

export function getSpotById(id: string): Spot | null {
  const row = stmt<SpotRow>(`SELECT ${SPOT_FIELDS} FROM spots WHERE id = ?`).get(id);
  return row ? toSpot(row) : null;
}

/** Ordered by floor price so the board reads largest-panel-first by default. */
export function listSpots(): Spot[] {
  return stmt<SpotRow>(
    `SELECT ${SPOT_FIELDS} FROM spots ORDER BY floor_price_cents DESC, key ASC`,
  )
    .all()
    .map(toSpot);
}

export function insertSpot(input: {
  key: string;
  name: string;
  panel: string;
  blurb: string;
  floorPriceCents: number;
  widthCm: number;
  heightCm: number;
  closesAt: number;
  status?: SpotStatus;
  id?: string;
  createdAt?: number;
}): Spot {
  const spot: Spot = {
    id: input.id ?? newId("spot"),
    key: input.key,
    name: input.name,
    panel: input.panel,
    blurb: input.blurb,
    floorPriceCents: input.floorPriceCents,
    widthCm: input.widthCm,
    heightCm: input.heightCm,
    status: input.status ?? "open",
    closesAt: input.closesAt,
    extensionCount: 0,
    createdAt: input.createdAt ?? Date.now(),
  };

  stmt(
    `INSERT INTO spots (id, key, name, panel, blurb, floor_price_cents, width_cm, height_cm,
                        status, closes_at, extension_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    spot.id,
    spot.key,
    spot.name,
    spot.panel,
    spot.blurb,
    spot.floorPriceCents,
    spot.widthCm,
    spot.heightCm,
    spot.status,
    spot.closesAt,
    spot.extensionCount,
    spot.createdAt,
  );

  return spot;
}

export function updateSpot(id: string, patch: Partial<Spot>): Spot | null {
  applyPatch<Spot>("spots", SPOT_COLUMNS, id, patch);
  return getSpotById(id);
}

/* ------------------------------------------------------------------ *
 * Bidders
 * ------------------------------------------------------------------ */

const BIDDER_FIELDS = `id, email, display_name, stripe_customer_id, created_at`;

export function getBidderById(id: string): Bidder | null {
  const row = stmt<BidderRow>(`SELECT ${BIDDER_FIELDS} FROM bidders WHERE id = ?`).get(id);
  return row ? toBidder(row) : null;
}

/** Email is the identity key, so it is matched case-insensitively. */
export function getBidderByEmail(email: string): Bidder | null {
  const row = stmt<BidderRow>(
    `SELECT ${BIDDER_FIELDS} FROM bidders WHERE email = ? COLLATE NOCASE`,
  ).get(email.trim());
  return row ? toBidder(row) : null;
}

export function insertBidder(input: {
  email: string;
  displayName: string;
  stripeCustomerId?: string | null;
  id?: string;
  createdAt?: number;
}): Bidder {
  const bidder: Bidder = {
    id: input.id ?? newId("bdr"),
    email: input.email.trim(),
    displayName: input.displayName.trim(),
    stripeCustomerId: input.stripeCustomerId ?? null,
    createdAt: input.createdAt ?? Date.now(),
  };

  stmt(
    `INSERT INTO bidders (id, email, display_name, stripe_customer_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    bidder.id,
    bidder.email,
    bidder.displayName,
    bidder.stripeCustomerId,
    bidder.createdAt,
  );

  return bidder;
}

export function updateBidder(id: string, patch: Partial<Bidder>): Bidder | null {
  applyPatch<Bidder>("bidders", BIDDER_COLUMNS, id, patch);
  return getBidderById(id);
}

/* ------------------------------------------------------------------ *
 * Bids
 * ------------------------------------------------------------------ */

const BID_FIELDS = `id, spot_id, bidder_id, amount_cents, status, stripe_checkout_session_id,
                    stripe_payment_intent_id, stripe_refund_id, created_at, paid_at,
                    refunded_at, sequence`;

/**
 * Inserts a bid, allocating its per-spot sequence in the same transaction.
 *
 * Reading MAX(sequence) and inserting as two separate statements would let two
 * simultaneous bids on the same spot claim the same number, and the tie-break
 * that decides who holds the spot would then be undefined. The unique index on
 * (spot_id, sequence) is the backstop if this is ever bypassed.
 */
export function insertBid(input: {
  spotId: string;
  bidderId: string;
  amountCents: number;
  status?: BidStatus;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  id?: string;
  createdAt?: number;
}): Bid {
  return transaction(() => {
    const next = stmt<{ next: number }>(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM bids WHERE spot_id = ?`,
    ).get(input.spotId);

    const bid: Bid = {
      id: input.id ?? newId("bid"),
      spotId: input.spotId,
      bidderId: input.bidderId,
      amountCents: input.amountCents,
      status: input.status ?? "pending_payment",
      stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null,
      stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      stripeRefundId: null,
      createdAt: input.createdAt ?? Date.now(),
      paidAt: null,
      refundedAt: null,
      sequence: next?.next ?? 1,
    };

    stmt(
      `INSERT INTO bids (id, spot_id, bidder_id, amount_cents, status,
                         stripe_checkout_session_id, stripe_payment_intent_id, stripe_refund_id,
                         created_at, paid_at, refunded_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bid.id,
      bid.spotId,
      bid.bidderId,
      bid.amountCents,
      bid.status,
      bid.stripeCheckoutSessionId,
      bid.stripePaymentIntentId,
      bid.stripeRefundId,
      bid.createdAt,
      bid.paidAt,
      bid.refundedAt,
      bid.sequence,
    );

    return bid;
  });
}

export function getBidById(id: string): Bid | null {
  const row = stmt<BidRow>(`SELECT ${BID_FIELDS} FROM bids WHERE id = ?`).get(id);
  return row ? toBid(row) : null;
}

export function updateBid(id: string, patch: Partial<Bid>): Bid | null {
  applyPatch<Bid>("bids", BID_COLUMNS, id, patch);
  return getBidById(id);
}

export function getBidByCheckoutSessionId(sessionId: string): Bid | null {
  const row = stmt<BidRow>(
    `SELECT ${BID_FIELDS} FROM bids WHERE stripe_checkout_session_id = ?`,
  ).get(sessionId);
  return row ? toBid(row) : null;
}

export function getBidByPaymentIntentId(paymentIntentId: string): Bid | null {
  const row = stmt<BidRow>(
    `SELECT ${BID_FIELDS} FROM bids WHERE stripe_payment_intent_id = ?`,
  ).get(paymentIntentId);
  return row ? toBid(row) : null;
}

/** Settled bids for a spot, best first: highest amount, earliest on a tie. */
export function getPaidBidsForSpot(spotId: string): Bid[] {
  return stmt<BidRow>(
    `SELECT ${BID_FIELDS} FROM bids
     WHERE spot_id = ? AND status IN (${LIVE_STATUS_PLACEHOLDERS})
     ORDER BY amount_cents DESC, sequence ASC`,
  )
    .all(spotId, ...LIVE_STATUS_VALUES)
    .map(toBid);
}

/** The bid currently holding the spot, or null while the spot is unsold. */
export function getTopPaidBid(spotId: string): Bid | null {
  const row = stmt<BidRow>(
    `SELECT ${BID_FIELDS} FROM bids
     WHERE spot_id = ? AND status IN (${LIVE_STATUS_PLACEHOLDERS})
     ORDER BY amount_cents DESC, sequence ASC
     LIMIT 1`,
  ).get(spotId, ...LIVE_STATUS_VALUES);
  return row ? toBid(row) : null;
}

export function countPaidBidsForSpot(spotId: string): number {
  const row = stmt<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bids
     WHERE spot_id = ? AND status IN (${LIVE_STATUS_PLACEHOLDERS})`,
  ).get(spotId, ...LIVE_STATUS_VALUES);
  return row?.n ?? 0;
}

/** Bid history for one spot, most recent first. Includes unsettled attempts. */
export function listBidsForSpot(spotId: string, limit = 50): Bid[] {
  return stmt<BidRow>(
    `SELECT ${BID_FIELDS} FROM bids WHERE spot_id = ? ORDER BY sequence DESC LIMIT ?`,
  )
    .all(spotId, limit)
    .map(toBid);
}

/** Money actually taken: only bids that reached a settled state count. */
export function getTotalRaisedCents(): number {
  const row = stmt<{ total: number | null }>(
    `SELECT SUM(amount_cents) AS total FROM bids WHERE status IN (${LIVE_STATUS_PLACEHOLDERS})`,
  ).get(...LIVE_STATUS_VALUES);
  return row?.total ?? 0;
}

/* ------------------------------------------------------------------ *
 * Artwork
 * ------------------------------------------------------------------ */

const ARTWORK_FIELDS = `id, bid_id, spot_id, bidder_id, filename, mime_type, byte_size,
                        stored_path, review_status, rejection_reason, created_at, reviewed_at`;

export function insertArtwork(input: {
  bidId: string;
  spotId: string;
  bidderId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  storedPath: string;
  reviewStatus?: ReviewStatus;
  id?: string;
  createdAt?: number;
}): Artwork {
  const artwork: Artwork = {
    id: input.id ?? newId("art"),
    bidId: input.bidId,
    spotId: input.spotId,
    bidderId: input.bidderId,
    filename: input.filename,
    mimeType: input.mimeType,
    byteSize: input.byteSize,
    storedPath: input.storedPath,
    reviewStatus: input.reviewStatus ?? "pending",
    rejectionReason: null,
    createdAt: input.createdAt ?? Date.now(),
    reviewedAt: null,
  };

  stmt(
    `INSERT INTO artwork (id, bid_id, spot_id, bidder_id, filename, mime_type, byte_size,
                          stored_path, review_status, rejection_reason, created_at, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artwork.id,
    artwork.bidId,
    artwork.spotId,
    artwork.bidderId,
    artwork.filename,
    artwork.mimeType,
    artwork.byteSize,
    artwork.storedPath,
    artwork.reviewStatus,
    artwork.rejectionReason,
    artwork.createdAt,
    artwork.reviewedAt,
  );

  return artwork;
}

export function getArtworkById(id: string): Artwork | null {
  const row = stmt<ArtworkRow>(`SELECT ${ARTWORK_FIELDS} FROM artwork WHERE id = ?`).get(id);
  return row ? toArtwork(row) : null;
}

/** A re-upload inserts a new row, so the newest one is the live submission. */
export function getArtworkByBidId(bidId: string): Artwork | null {
  const row = stmt<ArtworkRow>(
    `SELECT ${ARTWORK_FIELDS} FROM artwork WHERE bid_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(bidId);
  return row ? toArtwork(row) : null;
}

export function listArtwork(reviewStatus?: ReviewStatus): Artwork[] {
  const rows = reviewStatus
    ? stmt<ArtworkRow>(
        `SELECT ${ARTWORK_FIELDS} FROM artwork WHERE review_status = ? ORDER BY created_at ASC`,
      ).all(reviewStatus)
    : stmt<ArtworkRow>(`SELECT ${ARTWORK_FIELDS} FROM artwork ORDER BY created_at ASC`).all();
  return rows.map(toArtwork);
}

export function updateArtwork(id: string, patch: Partial<Artwork>): Artwork | null {
  applyPatch<Artwork>("artwork", ARTWORK_COLUMNS, id, patch);
  return getArtworkById(id);
}

/**
 * How many bids on this spot ever represented real money — including ones since
 * outbid and refunded. This is deliberately NOT the count of currently-paid
 * bids: a spot two people fought over reads "1 bid" under that definition,
 * which understates the contest. Abandoned checkouts and declines are excluded,
 * because they never were a bid in any meaningful sense.
 */
export function countSettledBidsForSpot(spotId: string): number {
  const row = stmt<{ n: number }>(
    `SELECT COUNT(*) AS n FROM bids
     WHERE spot_id = ? AND status IN ('paid', 'won', 'outbid', 'refunded')`,
  ).get(spotId);
  return row?.n ?? 0;
}
