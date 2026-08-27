import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUCTION } from "@/config/car";
import type { Artwork } from "@/lib/types";

/**
 * Each case gets its own SQLite file and its own upload directory.
 *
 * db.ts caches prepared statements per module instance and the handle itself on
 * globalThis, so a new file needs both thrown away: the same dance auction.test
 * does. UPLOAD_DIR is re-read on every call, so swapping the env var is enough
 * there, but a fresh directory per test is what makes "the only file in the
 * upload root is the one we just wrote" a usable assertion.
 */
const HANDLE = Symbol.for("datsun-100a-auction.db");
type GlobalWithHandle = typeof globalThis & { [HANDLE]?: { open: boolean; close(): void } };

let uploads: typeof import("@/lib/uploads");
let store: typeof import("@/lib/db");
let dir: string;
let root: string;

function dropHandle(): void {
  const g = globalThis as GlobalWithHandle;
  const handle = g[HANDLE];
  if (handle?.open) handle.close();
  delete g[HANDLE];
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "datsun-uploads-"));
  root = join(dir, "uploads");
  process.env.AUCTION_DB_PATH = join(dir, "auction.db");
  process.env.UPLOAD_DIR = root;
  dropHandle();
  vi.resetModules();
  store = await import("@/lib/db");
  uploads = await import("@/lib/uploads");
});

afterEach(() => {
  dropHandle();
  delete process.env.UPLOAD_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A bid to hang artwork off; the FK to bids means spot and bidder must exist. */
function seedBid(): { bidId: string; spotId: string; bidderId: string } {
  const spot = store.insertSpot({
    key: "door-main",
    name: "Door panel",
    panel: "Driver's door",
    blurb: "The big flat one.",
    floorPriceCents: 15_000,
    widthCm: 45,
    heightCm: 30,
    closesAt: Date.now() + 86_400_000,
  });
  const bidder = store.insertBidder({ email: "jo@example.com", displayName: "Jo" });
  const bid = store.insertBid({
    spotId: spot.id,
    bidderId: bidder.id,
    amountCents: 20_000,
    status: "paid",
  });
  return { bidId: bid.id, spotId: spot.id, bidderId: bidder.id };
}

function bytes(...parts: Array<number[] | string>): Uint8Array {
  const flat: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") for (const ch of part) flat.push(ch.charCodeAt(0));
    else flat.push(...part);
  }
  return Uint8Array.from(flat);
}

const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR");
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], [0, 16], "JFIF\0");
const WEBP = bytes("RIFF", [0x1a, 0, 0, 0], "WEBP", "VP8 ");
const CLEAN_SVG = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<path d="M8 8 L56 8 L32 56 Z" fill="#0071e3"/></svg>`,
);

function svg(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

function validate(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  byteSize?: number;
}) {
  return uploads.validateUpload({
    filename: input.filename,
    mimeType: input.mimeType,
    byteSize: input.byteSize ?? input.bytes.length,
    bytes: input.bytes,
  });
}

/* ------------------------------------------------------------------ *
 * Declared type vs actual bytes
 * ------------------------------------------------------------------ */

describe("mime and extension spoofing", () => {
  it("rejects JPEG bytes wearing a .png name and an image/png type", () => {
    const result = validate({ filename: "logo.png", mimeType: "image/png", bytes: JPEG });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("type_mismatch");
    expect(result.message).toContain("image/jpeg");
  });

  it("rejects PNG bytes wearing a .jpg name and an image/jpeg type", () => {
    const result = validate({ filename: "logo.jpg", mimeType: "image/jpeg", bytes: PNG });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("type_mismatch");
  });

  it("rejects a declared type outside the accepted list", () => {
    const gif = bytes("GIF89a");
    const result = validate({ filename: "logo.gif", mimeType: "image/gif", bytes: gif });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("type_not_accepted");
  });

  it("rejects bytes matching no accepted format even under an accepted type", () => {
    const gif = bytes("GIF89a", [0x01, 0x02, 0x03]);
    const result = validate({ filename: "logo.png", mimeType: "image/png", bytes: gif });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unrecognised_format");
  });

  it("rejects a RIFF container that is not WebP", () => {
    const avi = bytes("RIFF", [0x1a, 0, 0, 0], "AVI ", "LIST");
    const result = validate({ filename: "logo.webp", mimeType: "image/webp", bytes: avi });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unrecognised_format");
  });

  it("ignores charset parameters on the declared type", () => {
    const result = validate({
      filename: "logo.svg",
      mimeType: "image/svg+xml; charset=utf-8",
      bytes: CLEAN_SVG,
    });
    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Size
 * ------------------------------------------------------------------ */

describe("size limits", () => {
  it("rejects a file over maxLogoBytes", () => {
    const oversize = new Uint8Array(AUCTION.maxLogoBytes + 1);
    oversize.set(PNG, 0);
    const result = validate({ filename: "big.png", mimeType: "image/png", bytes: oversize });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too_large");
  });

  it("rejects an under-reported size whose real bytes are over the limit", () => {
    const oversize = new Uint8Array(AUCTION.maxLogoBytes + 1);
    oversize.set(PNG, 0);
    const result = validate({
      filename: "big.png",
      mimeType: "image/png",
      bytes: oversize,
      byteSize: 1024,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("too_large");
  });

  it("rejects an empty file", () => {
    const result = validate({
      filename: "nothing.png",
      mimeType: "image/png",
      bytes: new Uint8Array(0),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty");
  });
});

/* ------------------------------------------------------------------ *
 * Accepted formats
 * ------------------------------------------------------------------ */

describe("accepted formats", () => {
  const cases: Array<[string, Uint8Array, string, string]> = [
    ["PNG", PNG, "image/png", ".png"],
    ["JPEG", JPEG, "image/jpeg", ".jpg"],
    ["WebP", WEBP, "image/webp", ".webp"],
    ["SVG", CLEAN_SVG, "image/svg+xml", ".svg"],
  ];

  for (const [label, data, mimeType, extension] of cases) {
    it(`accepts ${label} magic bytes`, () => {
      const result = validate({ filename: `logo${extension}`, mimeType, bytes: data });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.mimeType).toBe(mimeType);
      expect(result.extension).toBe(extension);
      expect(result.byteSize).toBe(data.length);
    });
  }

  it("accepts an SVG behind an XML prolog and a BOM", () => {
    const prefixed = bytes([0xef, 0xbb, 0xbf], `<?xml version="1.0"?>\n`);
    const merged = new Uint8Array(prefixed.length + CLEAN_SVG.length);
    merged.set(prefixed, 0);
    merged.set(CLEAN_SVG, prefixed.length);
    const result = validate({ filename: "logo.svg", mimeType: "image/svg+xml", bytes: merged });
    expect(result.ok).toBe(true);
  });

  it("rejects non-SVG XML wearing the SVG type", () => {
    const rss = svg(`<?xml version="1.0"?><rss version="2.0"><channel/></rss>`);
    const result = validate({ filename: "feed.svg", mimeType: "image/svg+xml", bytes: rss });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unrecognised_format");
  });
});

/* ------------------------------------------------------------------ *
 * SVG active content
 * ------------------------------------------------------------------ */

describe("SVG active content", () => {
  function expectUnsafe(source: string): void {
    const result = validate({
      filename: "logo.svg",
      mimeType: "image/svg+xml",
      bytes: svg(source),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("svg_unsafe");
  }

  it("rejects an SVG containing <script>", () => {
    expectUnsafe(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/admin/summary")</script></svg>`,
    );
  });

  it("rejects an SVG with an onload handler", () => {
    expectUnsafe(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(document.cookie)"/>`);
  });

  it("rejects an SVG with a javascript: href", () => {
    expectUnsafe(
      `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="9" height="9"/></a></svg>`,
    );
  });

  it("rejects a javascript: href hidden behind a numeric character reference", () => {
    expectUnsafe(
      `<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="&#106;avascript:alert(1)"><rect width="9" height="9"/></a></svg>`,
    );
  });

  it("rejects an SVG containing <foreignObject>", () => {
    expectUnsafe(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="9" height="9"><body xmlns="http://www.w3.org/1999/xhtml">hi</body></foreignObject></svg>`,
    );
  });

  it("rejects an SVG declaring entities", () => {
    expectUnsafe(
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>`,
    );
  });

  it("accepts a clean SVG", () => {
    const result = validate({
      filename: "logo.svg",
      mimeType: "image/svg+xml",
      bytes: CLEAN_SVG,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sniffed).toBe("svg");
  });

  it("accepts a clean SVG carrying a plain DOCTYPE, as Illustrator exports it", () => {
    const exported = svg(
      `<?xml version="1.0" encoding="utf-8"?>\n` +
        `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`,
    );
    const result = validate({ filename: "logo.svg", mimeType: "image/svg+xml", bytes: exported });
    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

describe("storeArtwork", () => {
  it("keeps a traversal filename out of the stored path", () => {
    const { bidId, spotId, bidderId } = seedBid();
    const artwork = uploads.storeArtwork({
      bidId,
      spotId,
      bidderId,
      filename: "../../etc/passwd",
      mimeType: "image/png",
      bytes: PNG,
    });

    expect(artwork.storedPath).not.toContain("..");
    expect(artwork.storedPath).not.toContain("/");
    expect(artwork.storedPath).toMatch(/^art_[0-9A-Za-z]{22}\.png$/);
    // The display name keeps only the basename, so nothing path-shaped survives.
    expect(artwork.filename).toBe("passwd");

    const absolute = uploads.resolveArtworkPath(artwork);
    expect(absolute.startsWith(root + sep)).toBe(true);
    expect(existsSync(absolute)).toBe(true);
    expect(readdirSync(root)).toEqual([artwork.storedPath]);
    // Nothing was written beside the upload root either.
    expect(existsSync(join(dir, "etc"))).toBe(false);
  });

  it("names the file from the sniffed type, not the uploaded extension", () => {
    const { bidId, spotId, bidderId } = seedBid();
    const artwork = uploads.storeArtwork({
      bidId,
      spotId,
      bidderId,
      filename: "logo.svg.png",
      mimeType: "image/svg+xml",
      bytes: CLEAN_SVG,
    });
    expect(artwork.storedPath.endsWith(".svg")).toBe(true);
    expect(artwork.mimeType).toBe("image/svg+xml");
    expect(artwork.reviewStatus).toBe("pending");
    expect(store.getArtworkByBidId(bidId)?.id).toBe(artwork.id);
  });

  it("throws rather than storing bytes validateUpload would refuse", () => {
    const { bidId, spotId, bidderId } = seedBid();
    expect(() =>
      uploads.storeArtwork({
        bidId,
        spotId,
        bidderId,
        filename: "logo.png",
        mimeType: "image/png",
        bytes: JPEG,
      }),
    ).toThrow(uploads.UploadValidationError);
    expect(existsSync(root)).toBe(false);
  });

  it("supersedes the previous artwork and deletes its file", () => {
    const { bidId, spotId, bidderId } = seedBid();
    const first = uploads.storeArtwork({
      bidId,
      spotId,
      bidderId,
      filename: "first.png",
      mimeType: "image/png",
      bytes: PNG,
    });
    const firstPath = uploads.resolveArtworkPath(first);
    expect(existsSync(firstPath)).toBe(true);

    const second = uploads.storeArtwork({
      bidId,
      spotId,
      bidderId,
      filename: "second.svg",
      mimeType: "image/svg+xml",
      bytes: CLEAN_SVG,
    });

    expect(second.id).not.toBe(first.id);
    expect(store.getArtworkByBidId(bidId)?.id).toBe(second.id);

    const superseded = store.getArtworkById(first.id);
    expect(superseded?.reviewStatus).toBe("rejected");
    expect(superseded?.rejectionReason).toContain("Superseded");
    // A superseded row must not sit in the moderation queue.
    expect(store.listArtwork("pending").map((a) => a.id)).toEqual([second.id]);

    expect(existsSync(firstPath)).toBe(false);
    expect(readdirSync(root)).toEqual([second.storedPath]);
  });
});

/* ------------------------------------------------------------------ *
 * Reading back
 * ------------------------------------------------------------------ */

describe("resolveArtworkPath and readArtworkBytes", () => {
  it("refuses a stored path that escapes the upload root", () => {
    expect(() => uploads.resolveArtworkPath({ storedPath: "../../etc/passwd" })).toThrow(
      uploads.ArtworkPathError,
    );
    expect(() => uploads.resolveArtworkPath({ storedPath: "/etc/passwd" })).toThrow(
      uploads.ArtworkPathError,
    );
  });

  it("returns the bytes with an inline disposition for a raster logo", () => {
    const { bidId, spotId, bidderId } = seedBid();
    const artwork = uploads.storeArtwork({
      bidId,
      spotId,
      bidderId,
      filename: "logo.png",
      mimeType: "image/png",
      bytes: PNG,
    });

    const file = uploads.readArtworkBytes(artwork);
    expect(Array.from(file.bytes)).toEqual(Array.from(PNG));
    expect(file.mimeType).toBe("image/png");
    expect(file.contentDisposition).toMatch(/^inline; filename="logo\.png"/);
  });

  it("serves an SVG as an attachment so a direct hit cannot execute it", () => {
    const { bidId, spotId, bidderId } = seedBid();
    const artwork = uploads.storeArtwork({
      bidId,
      spotId,
      bidderId,
      filename: `"; drop\\table.svg`,
      mimeType: "image/svg+xml",
      bytes: CLEAN_SVG,
    });

    const file = uploads.readArtworkBytes(artwork);
    expect(file.mimeType).toBe("image/svg+xml");
    expect(file.contentDisposition.startsWith("attachment;")).toBe(true);
    // Quotes and backslashes would end the header value early.
    const quoted = file.contentDisposition.match(/filename="([^"]*)"/)?.[1] ?? "";
    expect(quoted).not.toContain('"');
    expect(quoted).not.toContain("\\");
  });

  it("resolves against UPLOAD_DIR as it is at call time", () => {
    const artwork: Pick<Artwork, "storedPath"> = { storedPath: "art_x.png" };
    const moved = join(dir, "elsewhere");
    process.env.UPLOAD_DIR = moved;
    expect(uploads.resolveArtworkPath(artwork)).toBe(join(moved, "art_x.png"));
  });
});
