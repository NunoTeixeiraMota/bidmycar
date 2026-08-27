import Link from "next/link";

const LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "https://x.com/zNunoTeixeira", label: "X" },
] as const;

/** External links leave the tab; `noreferrer` goes with `_blank` so the new
 *  document cannot reach back through `window.opener`. */
function isExternal(href: string): boolean {
  return href.startsWith("http");
}

export default function Footer() {
  return (
    <footer className="hairline-t bg-haze text-[12px] leading-[1.6] text-faint">
      <div className="shell py-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {LINKS.map((link) => (
              <li key={link.href}>
                {isExternal(link.href) ? (
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm transition-colors duration-200 ease-showroom hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
                  >
                    {link.label}
                  </a>
                ) : (
                  <Link
                    href={link.href}
                    className="rounded-sm transition-colors duration-200 ease-showroom hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
                  >
                    {link.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>

          <p>
            © {new Date().getFullYear()} Brand My Datsun. Not affiliated with Nissan or Datsun.
          </p>
        </div>
      </div>
    </footer>
  );
}
