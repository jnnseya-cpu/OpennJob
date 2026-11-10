import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Terms of use · OpennJob' };

export default function TermsPage() {
  return (
    <article className="prose">
      <h2>Terms of use</h2>
      <p className="small muted">Last updated: 10 October 2026. The version you accepted when you registered is recorded on your Account.</p>
      <p className="note small">
        Draft for review. Replace the bracketed details with your registered company information and have these terms checked by a
        qualified adviser before a public launch.
      </p>

      <h3>1. Who we are</h3>
      <p>OpennJob (“we”, “us”) is operated by [Company name], [registered address], company number [number]. These terms govern your use of the OpennJob website and service.</p>

      <h3>2. Eligibility and your account</h3>
      <p>You must be 18 or over and legally able to work in the countries you apply to. Keep your password safe; you are responsible for activity on your account. One account per person. Accounts may currently be by invitation.</p>

      <h3>3. What the service does — and does not do</h3>
      <ul>
        <li>OpennJob finds and scores jobs, prepares a tailored CV and statement from your own information, and helps you apply.</li>
        <li>It <b>does not guarantee</b> any job, interview, or outcome, and the number and quality of matches depend on your profile and the market.</li>
        <li>It is <b>not legal, immigration or careers advice</b>. AI-generated text may contain errors — you must review everything before it is sent.</li>
        <li>OpennJob never answers a declaration for you, never defeats CAPTCHAs or site security, and does not automate sites against their terms.</li>
      </ul>

      <h3>4. Your responsibilities</h3>
      <ul>
        <li>Give accurate, truthful information. You are responsible for everything submitted in your name, including answers to declarations, which only you provide.</li>
        <li>Review each application before it is sent or submitted. Where OpennJob sends by e-mail under your authorisation, you confirm the content is accurate.</li>
        <li>Use the service lawfully and in line with our <Link href="/acceptable-use/">Acceptable Use Policy</Link>.</li>
      </ul>

      <h3>5. Automatic sending (standing authorisation)</h3>
      <p>
        If you switch on automatic mode, you give a dated, revocable authorisation for OpennJob to e-mail applications in your name to
        recruiter addresses named in adverts, within the limits shown in the app. You can pause or revoke it at any time in your Account.
        OpennJob will not auto-submit an employer form that asks a declaration.
      </p>

      <h3>6. Fees</h3>
      <p>[Describe any subscription or fees, billing cycle, trials and refunds here, or state that the service is currently free during the pilot.] Prices and what each plan includes are shown before you pay.</p>

      <h3>7. Intellectual property</h3>
      <p>You keep ownership of your CV and the content you provide. You grant us a licence to process it solely to provide the service. The OpennJob software, brand and site are ours or our licensors’.</p>

      <h3>8. Availability, changes and termination</h3>
      <p>We may change, suspend or withdraw features, and we may update these terms; we will show the current version in the app. You may close your account at any time; we may suspend accounts that breach these terms or the Acceptable Use Policy.</p>

      <h3>9. Liability</h3>
      <p>To the extent permitted by law, we are not liable for lost opportunities, lost earnings, or the decisions of employers, nor for content you approved for sending. Nothing here limits liability that cannot be limited by law. [Insert any cap and exclusions reviewed by your adviser.]</p>

      <h3>10. Governing law</h3>
      <p>These terms are governed by the laws of [England and Wales / your jurisdiction], and its courts have exclusive jurisdiction.</p>

      <h3>11. Contact</h3>
      <p>Questions about these terms: <Link href="/contact/">contact us</Link>.</p>
    </article>
  );
}
