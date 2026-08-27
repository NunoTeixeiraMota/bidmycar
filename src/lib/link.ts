/**
 * Bidder websites.
 *
 * Whatever comes out of here is rendered into an `href` on a page anyone can
 * read, so this is a security boundary rather than a formatting nicety. Only
 * http and https survive it: `javascript:` and `data:` are the two schemes that
 * turn a link into script execution in the reader's session, and neither has
 * any business being a company's website.
 */

/** Longer than any real address anyone types into a bid form. */
const MAX_LENGTH = 300;

/**
 * Normalise a typed website into a URL safe to put in an href, or null.
 *
 * A bare "acme.ie" is accepted and read as https, because that is how people
 * write their own address and refusing it would only teach them to paste
 * something worse.
 */
export function normaliseLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LENGTH) return null;

  // A scheme-relative "//evil.example" inherits our scheme and is a real
  // address elsewhere; treat anything without an explicit scheme as a hostname.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // "https://" parses with an empty host on some inputs; a link to nowhere is
  // worse than no link.
  if (!url.hostname || !url.hostname.includes(".")) return null;

  return url.toString();
}

/**
 * The address as a person would say it: no scheme, no trailing slash.
 * Display only; the href always carries the full normalised URL.
 */
export function linkLabel(link: string): string {
  try {
    const url = new URL(link);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return link;
  }
}
