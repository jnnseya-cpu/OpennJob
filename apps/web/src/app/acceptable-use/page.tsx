import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Acceptable use · OpennJob' };

export default function AcceptableUsePage() {
  return (
    <article className="prose">
      <h2>Acceptable use policy</h2>
      <p className="small muted">Last updated: 10 October 2026. This policy forms part of our <Link href="/terms/">Terms of use</Link>.</p>

      <p>OpennJob is built to help you apply honestly. When you use it, you agree:</p>
      <ul>
        <li>To give <b>truthful, accurate</b> information about yourself, your experience and your qualifications.</li>
        <li>That you are the person applying, and you will not impersonate anyone or use someone else’s identity or documents.</li>
        <li>To use <b>one account</b> for yourself, and not to resell or share access.</li>
        <li>To answer declarations (criminal records, right to work, fitness to practise, and similar) yourself, truthfully, on each employer’s form.</li>
        <li>Not to use OpennJob to deceive employers, send spam, or apply in bad faith.</li>
        <li>Not to attempt to bypass site security, rate limits, CAPTCHAs or other protections — OpennJob is designed never to do this, and neither should you.</li>
        <li>Not to upload malware, attempt to break or overload the service, or access data that is not yours.</li>
        <li>To comply with the laws that apply to you and to the roles and countries you apply to.</li>
      </ul>

      <p>
        We may suspend or close accounts that breach this policy. If you see misuse, please <Link href="/contact/">tell us</Link>.
      </p>
    </article>
  );
}
