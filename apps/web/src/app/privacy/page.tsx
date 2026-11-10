import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Privacy notice · OpennJob' };

export default function PrivacyPage() {
  return (
    <article className="prose">
      <h2>Privacy notice</h2>
      <p className="small muted">Last updated: 10 October 2026.</p>
      <p className="note small">
        Draft for review. Confirm the controller details, lawful bases, processors and retention periods with a qualified adviser, and
        register with your data-protection authority where required, before a public launch.
      </p>

      <h3>Who controls your data</h3>
      <p>[Company name], [registered address] is the data controller. Data-protection contact: <a href="mailto:privacy@opennjob.com">privacy@opennjob.com</a>. [ICO / supervisory authority registration number: …]</p>

      <h3>What we collect</h3>
      <ul>
        <li><b>Account:</b> e-mail address, password (stored only as a secure hash), verification and session tokens.</li>
        <li><b>Profile:</b> your CV text, contact details, preferences, credential “passport” (e.g. registration numbers, tickets, referees) and the screening and declaration answers you choose to save.</li>
        <li><b>Applications:</b> the jobs matched, the tailored CVs and statements prepared, and the receipts of what was sent.</li>
        <li><b>Technical:</b> minimal logs needed to run and secure the service. We keep personal data out of logs.</li>
      </ul>

      <h3>Why we use it, and our lawful basis</h3>
      <p>To provide the service you asked for (performance of a contract), to keep it secure (legitimate interests), and to meet legal obligations. We do <b>not</b> sell your data or use it to train AI models.</p>

      <h3>Who processes it for us</h3>
      <ul>
        <li><b>AI provider (Anthropic):</b> your CV and job adverts are sent to generate tailored documents. [Confirm the data-processing agreement.]</li>
        <li><b>Hosting ([Hostinger / your host]):</b> the servers and database that run OpennJob.</li>
        <li><b>E-mail ([Resend / SMTP provider]):</b> to send verification, notifications and, where you authorise it, applications.</li>
      </ul>
      <p>Where processing involves transfers outside your country, appropriate safeguards (such as Standard Contractual Clauses) apply.</p>

      <h3>Security and retention</h3>
      <p>Sensitive fields are encrypted at rest and all traffic uses HTTPS. We keep your data while your account is active and delete or anonymise it after [retention period], except where the law requires us to keep records longer.</p>

      <h3>Your rights</h3>
      <p>
        You can access, correct, export or delete your data. <b>Export</b> and <b>Delete account</b> are available directly on your Account
        page; for anything else contact <a href="mailto:privacy@opennjob.com">privacy@opennjob.com</a>. You may complain to your
        data-protection authority [e.g. the ICO in the UK].
      </p>

      <h3>Cookies and local storage</h3>
      <p>We use only what the app needs to work — see the <Link href="/cookies/">Cookie Notice</Link>.</p>

      <h3>Changes</h3>
      <p>We will post updates here and show the current version in the app.</p>
    </article>
  );
}
