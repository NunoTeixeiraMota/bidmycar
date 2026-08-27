import { randomBytes } from "node:crypto";

/**
 * Opaque identifiers: `<prefix>_<22 base62 chars>`.
 *
 * 22 base62 characters is ~131 bits, collision-proof for our purposes without
 * the dashes and case-insensitivity traps of a UUID, and safe raw in a URL, a
 * cookie value, or a Stripe metadata field.
 */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 22;

// 62 * 4 = 248. Bytes at or above this would bias the low residues, so they are
// discarded rather than folded with `%`.
const REJECT_AT = 248;

export function newId(prefix: string): string {
  let out = "";
  while (out.length < ID_LENGTH) {
    // Over-draw so the common case needs a single syscall despite rejections.
    const chunk = randomBytes((ID_LENGTH - out.length) * 2);
    for (const byte of chunk) {
      if (byte >= REJECT_AT) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === ID_LENGTH) break;
    }
  }
  return `${prefix}_${out}`;
}
