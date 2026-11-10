import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Contact · OpennJob' };

export default function ContactPage() {
  return (
    <article className="prose">
      <h2>Contact us</h2>
      <p>We read every message. Please include your account e-mail (if you have one) and enough detail for us to help.</p>

      <h3>How to reach us</h3>
      <ul>
        <li><b>Support and general questions:</b> <a href="mailto:support@opennjob.com">support@opennjob.com</a></li>
        <li><b>Privacy and data requests</b> (access, export, deletion): <a href="mailto:privacy@opennjob.com">privacy@opennjob.com</a> — note that Export and Delete are also available directly on your <Link href="/account/">Account</Link> page.</li>
        <li><b>Postal address:</b> [Company name], [registered address].</li>
      </ul>

      <h3>What to expect</h3>
      <p>We aim to reply within [e.g. 2 working days]. OpennJob is a pilot run by a small team, so please bear with us.</p>

      <p className="small muted">
        OpennJob does not guarantee a job or an interview, and cannot give legal, immigration or careers advice. For how the service
        works, see <Link href="/how-it-works/">How it works</Link>; for your data, the <Link href="/privacy/">Privacy Notice</Link>.
      </p>
    </article>
  );
}
