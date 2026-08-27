import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import { AUCTION } from "@/config/car";
import { getArtworkByBidId, insertArtwork, transaction, updateArtwork } from "@/lib/db";
import { newId } from "@/lib/ids";
import type { Artwork } from "@/lib/types";

/**
 * Artwork storage.
 *
 * Everything here handles bytes posted by strangers which later end up
 * composited onto the public hero image, so this module is a security boundary
 * rather than a convenience wrapper. Three rules follow from that:
 *
 *  1. Nothing the client says about its own file is believed — not the mime
 *     type, not the extension, not the byte count. Only the magic bytes decide.
 *  2. The stored filename is generated here, never derived from the uploaded
 *     one, which is attacker-controlled and may contain `/` or `..`.
 *  3. The upload root sits OUTSIDE public/, so Next never statically serves it.
 *     Every read goes through a route that can check approval and ownership;
 *     unapproved artwork must not be reachable by guessing a URL.
 */

/* ------------------------------------------------------------------ *
 * The upload root
 * ------------------------------------------------------------------ */

/**
 * Resolved per call rather than frozen into a module constant: this module is
 * imported at build time as well as at request time, and tests point UPLOAD_DIR
 * at a fresh temp directory between cases.
 */
export function uploadRoot(): string {
  const configured = process.env.UPLOAD_DIR;
  return configured && configured.trim()
    ? resolve(configured.trim())
    : join(process.cwd(), "data", "uploads");
}

/* ------------------------------------------------------------------ *
 * Sniffing
 * ------------------------------------------------------------------ */

export type SniffedType = "png" | "jpeg" | "webp" | "svg";

/** Canonical mime and extension per format we actually recognise. */
const FORMATS: Readonly<Record<SniffedType, { mimeType: string; extension: string }>> = {
  png: { mimeType: "image/png", extension: ".png" },
  jpeg: { mimeType: "image/jpeg", extension: ".jpg" },
  webp: { mimeType: "image/webp", extension: ".webp" },
  svg: { mimeType: "image/svg+xml", extension: ".svg" },
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const UTF8_BOM = [0xef, 0xbb, 0xbf];

function matches(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function matchesAscii(bytes: Uint8Array, text: string, offset: number): boolean {
  return matches(bytes, [...text].map((c) => c.charCodeAt(0)), offset);
}

/** Strict UTF-8 decode. Invalid sequences mean it is not the XML we accept. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * What the bytes actually are, ignoring every claim made about them.
 *
 * Returns null for anything we do not recognise, which includes the formats a
 * browser will happily render but we do not want on the car (GIF, BMP, TIFF)
 * and everything that is not an image at all.
 */
export function sniffImageType(bytes: Uint8Array): SniffedType | null {
  if (matches(bytes, PNG_SIGNATURE)) return "png";
  if (matches(bytes, JPEG_SIGNATURE)) return "jpeg";
  // RIFF containers carry the real format at byte 8; "RIFF....AVI " is not ours.
  if (matchesAscii(bytes, "RIFF", 0) && matchesAscii(bytes, "WEBP", 8)) return "webp";

  // Non-fatal decode of a bounded head: this only has to answer "does an <svg>
  // element open this document". Truncation can split a multi-byte character,
  // so strictness is left to validateUpload, which decodes the whole file.
  const head = bytes.subarray(matches(bytes, UTF8_BOM) ? 3 : 0, 4096);
  const text = new TextDecoder("utf-8").decode(head);

  const leading = text.replace(/^[\s\uFEFF]+/, "");
  if (/^<svg[\s>/]/i.test(leading)) return "svg";
  // An XML prolog only counts as SVG if an <svg> element follows it; otherwise
  // this is some other XML dialect wearing an image's mime type.
  if (/^<\?xml[\s?]/i.test(leading) && /<svg[\s>/]/i.test(text)) return "svg";

  return null;
}

/* ------------------------------------------------------------------ *
 * SVG sanitation
 * ------------------------------------------------------------------ */

/**
 * SVG is the dangerous format, and the only one here that is not inert.
 *
 * A PNG is pixels; an SVG is XML that the browser parses in the DOM, executes
 * <script> inside, fires event handlers from, and can use to pull in remote
 * resources or reference the enclosing document. Served from our own origin it
 * would be a stored XSS against every visitor and, because the artwork route is
 * authenticated by cookie, against the admin reviewing it.
 *
 * So: reject rather than strip. A rewriting sanitiser has to be right about
 * every obfuscation an attacker can spell; a rejection only has to be right
 * about "this file contains something no logo needs". Legitimate vector logos
 * contain paths, fills and text — never scripts, handlers or external
 * references — so the false-positive cost is a designer re-exporting a file.
 *
 * This check is necessary but not sufficient. The read path must also serve
 * these bytes with the sniffed Content-Type and `Content-Disposition:
 * attachment` (see readArtworkBytes) so that a direct navigation to the file
 * downloads it instead of executing it in our origin, and the route must keep
 * unapproved artwork unreadable by anyone but its owner and an admin.
 */
const SVG_HAZARDS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /<script[\s>/]/, what: "a <script> element" },
  // Any on* attribute: onload, onerror, onmouseover, onbegin, onclick...
  { pattern: /[\s"';/]on[a-z]+\s*=/, what: "an inline event handler attribute" },
  // foreignObject smuggles arbitrary HTML — including <script> — into the SVG.
  { pattern: /<foreignobject[\s>/]/, what: "a <foreignObject> element" },
  { pattern: /<(?:iframe|embed|object|audio|video)[\s>/]/, what: "an embedded document element" },
  // href="javascript:..." and data: URLs, on href or the legacy xlink:href.
  {
    pattern: /(?:xlink:)?href\s*=\s*["']?\s*(?:javascript|data|vbscript)\s*:/,
    what: "a script or data: URL in an href",
  },
  // SMIL can assign to href or an on* attribute over time, which is a script
  // vector that never spells "script" anywhere near the element that runs it.
  { pattern: /<(?:animate|set)[\s>/][^>]*attributename\s*=\s*["']?\s*(?:xlink:)?href/, what: "a SMIL animation targeting href" },
  // Entity declarations are the entry point for expansion (billion laughs) and
  // external-entity (XXE) attacks on whatever parses the file next. A bare
  // <!DOCTYPE svg PUBLIC ...> is left alone — Illustrator and Inkscape both
  // emit one — but an internal subset carries the same payload as <!ENTITY>.
  { pattern: /<!entity[\s>]/, what: "an entity declaration" },
  { pattern: /<!doctype[^>[]*\[/, what: "a DOCTYPE with an internal subset" },
];

/**
 * Numeric character references survive XML parsing, so `&#106;avascript:` and
 * `javascript&#58;` reach the browser as a live URL while defeating a literal
 * search. Decoding them before scanning closes that gap; the raw text is
 * scanned too, since decoding could in principle create a false negative.
 */
function decodeNumericEntities(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (whole, body: string) => {
    const code = body[0]?.toLowerCase() === "x" ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : whole;
  });
}

function findSvgHazard(source: string): string | null {
  const raw = source.toLowerCase();
  const decoded = decodeNumericEntities(raw);
  for (const { pattern, what } of SVG_HAZARDS) {
    if (pattern.test(raw) || pattern.test(decoded)) return what;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export type UploadRejectionReason =
  | "empty"
  | "too_large"
  | "type_not_accepted"
  | "unrecognised_format"
  | "type_mismatch"
  | "svg_unsafe";

export interface UploadAccepted {
  ok: true;
  sniffed: SniffedType;
  /** The canonical type for the sniffed bytes — this, not the declared one. */
  mimeType: string;
  extension: string;
  byteSize: number;
}

export interface UploadRejected {
  ok: false;
  reason: UploadRejectionReason;
  /** Safe to show the uploader verbatim. */
  message: string;
}

export type UploadValidation = UploadAccepted | UploadRejected;

export interface UploadCandidate {
  filename: string;
  /** What the client claims. Checked against the bytes, never trusted alone. */
  mimeType: string;
  /** What the client claims the size is. `bytes.length` is the real one. */
  byteSize: number;
  bytes: Uint8Array;
}

function reject(reason: UploadRejectionReason, message: string): UploadRejected {
  return { ok: false, reason, message };
}

/** Strips `; charset=…` and casing so `IMAGE/PNG ;q=1` compares as `image/png`. */
function normaliseMime(declared: string): string {
  return declared.split(";")[0]!.trim().toLowerCase();
}

const ACCEPTED: readonly string[] = AUCTION.acceptedLogoTypes;

export function validateUpload(candidate: UploadCandidate): UploadValidation {
  const actualSize = candidate.bytes.length;
  if (actualSize === 0) return reject("empty", "That file is empty.");

  const maxMb = Math.round(AUCTION.maxLogoBytes / (1024 * 1024));
  // Both sizes are checked: a client that under-reports its length must not get
  // a different answer here than a route that rejected early on Content-Length.
  if (actualSize > AUCTION.maxLogoBytes || candidate.byteSize > AUCTION.maxLogoBytes) {
    return reject("too_large", `Logos must be ${maxMb} MB or smaller.`);
  }

  const declared = normaliseMime(candidate.mimeType);
  if (!ACCEPTED.includes(declared)) {
    return reject("type_not_accepted", "Logos must be a PNG, JPEG, WebP or SVG file.");
  }

  const sniffed = sniffImageType(candidate.bytes);
  if (sniffed === null) {
    return reject(
      "unrecognised_format",
      "That file is not a PNG, JPEG, WebP or SVG — its contents do not match any of them.",
    );
  }

  const format = FORMATS[sniffed];
  // The interesting case: a real JPEG named .png and declared image/png. The
  // upload is refused rather than silently re-typed, because a client whose
  // claim disagrees with its own bytes is either broken or probing.
  if (format.mimeType !== declared) {
    return reject(
      "type_mismatch",
      `That file is declared as ${declared} but its contents are ${format.mimeType}. Re-export it and try again.`,
    );
  }

  if (sniffed === "svg") {
    const text = decodeUtf8(candidate.bytes);
    if (text === null) {
      return reject("unrecognised_format", "That SVG is not valid UTF-8 text.");
    }
    const hazard = findSvgHazard(text);
    if (hazard !== null) {
      return reject(
        "svg_unsafe",
        `That SVG contains ${hazard}, which we cannot accept. Export it as a flattened SVG with outlines, or send a PNG.`,
      );
    }
  }

  return { ok: true, sniffed, mimeType: format.mimeType, extension: format.extension, byteSize: actualSize };
}

/** Thrown by storeArtwork when handed bytes that validateUpload would refuse. */
export class UploadValidationError extends Error {
  constructor(readonly rejection: UploadRejected) {
    super(rejection.message);
    this.name = "UploadValidationError";
  }
}

/* ------------------------------------------------------------------ *
 * Storing
 * ------------------------------------------------------------------ */

/**
 * The uploader's filename is kept for display only — shown to the admin next to
 * the image so "logo-final-v3.svg" still means something. It never reaches the
 * filesystem, so this only has to be safe to print: no path parts, no control
 * characters, bounded length.
 */
function displayFilename(raw: string, extension: string): string {
  const stripped = basename(raw.replace(/\\/g, "/")).replace(/\p{Cc}/gu, "").trim();
  const safe = stripped.replace(/^\.+/, "").slice(0, 120);
  return safe || `logo${extension}`;
}

export interface StoreArtworkInput {
  bidId: string;
  spotId: string;
  bidderId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * Write the bytes and record them as pending review.
 *
 * Validates again rather than trusting the caller to have done it: this is the
 * only function that writes attacker-supplied bytes to disk, so it does not
 * accept "the route already checked" as an argument. Callers wanting a typed
 * rejection to show the user should call validateUpload first; reaching the
 * throw here means a bug upstream.
 */
export function storeArtwork(input: StoreArtworkInput): Artwork {
  const validation = validateUpload({
    filename: input.filename,
    mimeType: input.mimeType,
    byteSize: input.bytes.length,
    bytes: input.bytes,
  });
  if (!validation.ok) throw new UploadValidationError(validation);

  const root = uploadRoot();
  mkdirSync(root, { recursive: true });

  const id = newId("art");
  // The stored name comes from the id and the SNIFFED extension. Nothing the
  // uploader controls reaches this string, so "../../etc/passwd" and a .svg
  // named .png both land as an ordinary file inside the root.
  const storedPath = `${id}${validation.extension}`;
  const absolute = resolve(root, storedPath);

  const previous = getArtworkByBidId(input.bidId);

  // 0o600: the process that wrote it is the only one that needs to read it.
  writeFileSync(absolute, input.bytes, { mode: 0o600, flag: "wx" });

  let artwork: Artwork;
  try {
    artwork = transaction(() => {
      const inserted = insertArtwork({
        id,
        bidId: input.bidId,
        spotId: input.spotId,
        bidderId: input.bidderId,
        filename: displayFilename(input.filename, validation.extension),
        mimeType: validation.mimeType,
        byteSize: validation.byteSize,
        storedPath,
        reviewStatus: "pending",
        // getArtworkByBidId breaks ties on created_at, and a re-upload seconds
        // after the first would otherwise be ambiguous within the same
        // millisecond. Stepping past the previous row keeps "newest wins" true.
        createdAt: previous ? Math.max(Date.now(), previous.createdAt + 1) : Date.now(),
      });

      if (previous) {
        updateArtwork(previous.id, {
          reviewStatus: "rejected",
          rejectionReason: "Superseded by a later upload.",
          reviewedAt: Date.now(),
        });
      }

      return inserted;
    });
  } catch (error) {
    // The row is the record of truth; a file with no row is unreachable litter.
    rmSync(absolute, { force: true });
    throw error;
  }

  // Only after the new row is committed, so a crash mid-replace leaves the old
  // artwork intact rather than leaving a row pointing at nothing.
  if (previous) deleteArtworkFile(previous);

  return artwork;
}

/* ------------------------------------------------------------------ *
 * Reading back
 * ------------------------------------------------------------------ */

/** The stored path escaped the upload root — refuse rather than follow it. */
export class ArtworkPathError extends Error {
  constructor(storedPath: string) {
    super(`Artwork path "${storedPath}" resolves outside the upload root.`);
    this.name = "ArtworkPathError";
  }
}

/**
 * Absolute path for a stored artwork.
 *
 * storedPath is generated in storeArtwork and cannot contain traversal, so this
 * assertion should never fire. It exists because that guarantee is one bad
 * migration or one hand-edited row away from being false, and the cost of being
 * wrong is reading an arbitrary file off the server.
 */
export function resolveArtworkPath(artwork: Pick<Artwork, "storedPath">): string {
  const root = resolve(uploadRoot());
  const absolute = resolve(root, artwork.storedPath);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    throw new ArtworkPathError(artwork.storedPath);
  }
  return absolute;
}

function deleteArtworkFile(artwork: Pick<Artwork, "storedPath">): void {
  try {
    rmSync(resolveArtworkPath(artwork), { force: true });
  } catch {
    // A path we refuse to resolve is a path we refuse to unlink. Leaving the
    // stray file is strictly safer than deleting whatever it points at.
  }
}

export interface ArtworkBytes {
  bytes: Uint8Array;
  /** The type sniffed at upload, never the one the uploader declared. */
  mimeType: string;
  contentDisposition: string;
}

/**
 * Bytes plus the headers a route handler must send with them.
 *
 * SVG is served as an attachment. Browsers ignore Content-Disposition for
 * subresources, so `<img src>` still renders the logo, but a visitor who
 * navigates straight to the file gets a download instead of a document
 * executing in our origin — which is the one path where a hazard that slipped
 * past validateUpload would actually become script. Raster formats are inert
 * and are served inline so they can be opened in a tab for review.
 */
export function readArtworkBytes(artwork: Artwork): ArtworkBytes {
  const bytes = readFileSync(resolveArtworkPath(artwork));
  const inline = artwork.mimeType !== FORMATS.svg.mimeType;
  const name = displayFilename(artwork.filename, "");

  // RFC 5987: the ASCII fallback keeps quotes and backslashes out of the header,
  // the filename* copy carries the real name for anything that understands it.
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;

  return { bytes, mimeType: artwork.mimeType, contentDisposition: disposition };
}
