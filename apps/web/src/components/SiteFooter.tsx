import Link from 'next/link';

/**
 * Shared site footer: the standard information and policy links, shown on every page.
 * The legal pages it links to are honest drafts with placeholders for the operator's real
 * company details; replace those and have them reviewed before a public launch.
 */
const LINKS: [string, string][] = [
  ['/about/', 'About'],
  ['/how-it-works/', 'How it works'],
  ['/terms/', 'Terms'],
  ['/privacy/', 'Privacy'],
  ['/acceptable-use/', 'Acceptable use'],
  ['/cookies/', 'Cookies'],
  ['/contact/', 'Contact'],
];

export function SiteFooter() {
  return (
    <footer className="site-foot" aria-label="Site information">
      <nav className="site-foot-links" aria-label="Footer">
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
      </nav>
      <p className="small muted">
        © {new Date().getFullYear()} OpennJob. Pilot build — no job or interview is guaranteed. OpennJob prepares applications and,
        where you allow it, sends them; you remain responsible for what is submitted in your name.
      </p>
    </footer>
  );
}
