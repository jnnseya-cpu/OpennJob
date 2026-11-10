import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'About · OpennJob' };

export default function AboutPage() {
  return (
    <article className="prose">
      <h2>About OpennJob</h2>
      <p>
        OpennJob is a job-application assistant for people who would rather send a few strong, honest applications than hundreds of
        generic ones. You store your CV, preferences and credentials once; OpennJob finds roles that fit, scores each against your CV
        with the evidence shown, writes a tailored CV and supporting statement, and helps you apply — automatically by e-mail where an
        advert allows it, and with a ready-to-submit pack you complete yourself everywhere else.
      </p>

      <h3>What we believe</h3>
      <ul>
        <li><b>Truth over volume.</b> Every tailored CV and statement is checked against your own CV. Anything it cannot support is removed, never invented.</li>
        <li><b>You stay in control.</b> OpennJob never answers a declaration for you, and never submits a form that asks one without your say-so.</li>
        <li><b>We play by the rules.</b> No password harvesting, no defeating CAPTCHAs or bot checks, and no automating sites against their terms — the things that get applicants’ accounts banned.</li>
        <li><b>Honesty about results.</b> OpennJob does not guarantee a job or an interview, and does not give legal or careers advice.</li>
      </ul>

      <h3>Who it is for</h3>
      <p>
        It is being proved first with experienced professionals in regulated and technical fields — healthcare, construction, energy and
        similar — where a truthful, well-matched application matters more than sheer quantity. Accounts are currently by invitation while
        the pilot runs.
      </p>

      <h3>How we handle your data</h3>
      <p>
        You can export or delete everything we hold about you at any time from your Account page. Sensitive fields are encrypted, and we
        do not sell your data. See the <Link href="/privacy/">Privacy Notice</Link> for the detail and <Link href="/how-it-works/">How it works</Link> for the full flow.
      </p>

      <p className="small muted">Questions? <Link href="/contact/">Contact us</Link>.</p>
    </article>
  );
}
