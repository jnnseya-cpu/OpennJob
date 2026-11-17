import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Cookie notice · OpennJob' };

export default function CookiesPage() {
  return (
    <article className="prose">
      <h2>Cookie notice</h2>
      <p className="small muted">Last updated: 10 October 2026.</p>

      <p>
        OpennJob keeps to the minimum needed to work. We do not use advertising cookies, and we do not run third-party tracking or
        analytics cookies [confirm before launch if you add any]. What we store on your device:
      </p>

      <table className="plain">
        <thead>
          <tr><th>What</th><th>Where</th><th>Why</th></tr>
        </thead>
        <tbody>
          <tr><td>Sign-in session</td><td>Session storage</td><td>Keeps you signed in for the tab; cleared when you close it.</td></tr>
          <tr><td>“Keep me signed in” token</td><td>Local storage</td><td>Only if you tick it: lets you stay signed in across visits. Holds no personal data and can be revoked by signing out.</td></tr>
          <tr><td>Preferences (mode, industry pack, light/dark theme)</td><td>Local storage</td><td>Remembers your choices between visits. No personal data.</td></tr>
        </tbody>
      </table>

      <p>
        These are essential to the service or set only on your choice, so no separate consent banner is required for them. If that
        changes (for example if analytics is added), we will update this notice and ask for consent where the law requires it.
      </p>
      <p className="small muted">See also our <Link href="/privacy/">Privacy Notice</Link>.</p>
    </article>
  );
}
